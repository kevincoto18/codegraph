/**
 * C# parser built on Tree-sitter.
 *
 * Extracts namespaces (block and file-scoped), `using` directives, types
 * (with base types and field/property types), methods, constructors and
 * properties with bodies. Calls are typed with what the file says about
 * their receiver (parameters, locals, `var x = new T()`, fields, properties),
 * then resolved by type in the linker (see `scope.ts`).
 */
import type { Node, Parser } from '@vscode/tree-sitter-wasm';
import { Query } from '@vscode/tree-sitter-wasm';

import type { RelPath } from '../../shared';
import { CONSTRUCTOR_NAME } from './javaParser';
import { createTreeSitterParser, loadTreeSitterLanguage } from './treeSitter';
import type { FunctionDraft } from './treeSitterDrafts';
import {
  endLine,
  findEnclosingDraft,
  hasKeyword,
  namedChildren,
  sortDrafts,
  startLine,
  toParsedFunctions,
} from './treeSitterDrafts';
import type { ParsedCall, ParsedFile, ParsedImport, ParsedType } from './types';

/** Grammar file shipped in `dist/grammars`. */
const CSHARP_GRAMMAR = 'tree-sitter-c-sharp.wasm';

/** Nodes read inside member bodies, in one query run. */
const BODY_QUERY = `
(parameter) @param
(local_declaration_statement) @local
(foreach_statement) @for
(invocation_expression) @call
(object_creation_expression) @new
`;

/** Declarations of types with members. */
const TYPE_DECLARATIONS: ReadonlySet<string> = new Set([
  'class_declaration',
  'struct_declaration',
  'interface_declaration',
  'record_declaration',
  'record_struct_declaration',
]);

/** Modifiers that make a member visible outside its file's type. */
const EXPORTED_MODIFIERS: ReadonlySet<string> = new Set(['public', 'internal', 'protected']);

/** Loaded grammar, parser and query. */
interface CSharpRuntime {
  readonly parser: Parser;
  readonly body: Query;
}

let runtime: CSharpRuntime | undefined;

/**
 * Loads the C# grammar (once). Must complete before {@link parseCSharp}.
 *
 * @returns Resolves when the parser is ready.
 */
export async function prepareCSharp(): Promise<void> {
  if (runtime === undefined) {
    const language = await loadTreeSitterLanguage(CSHARP_GRAMMAR);
    runtime = { parser: createTreeSitterParser(language), body: new Query(language, BODY_QUERY) };
  }
}

/**
 * Simple name of a type written in the source (`List<User>` → `List`,
 * `App.Data.Repo` → `Repo`, `Repo?` / `Repo[]` → `Repo`).
 *
 * @param node - Type node.
 * @returns The name, or `null` for predefined types, `var` and unknown shapes.
 */
export function csharpTypeName(node: Node | null): string | null {
  if (node === null) {
    return null;
  }
  switch (node.type) {
    case 'identifier':
      return node.text;
    case 'generic_name':
      return namedChildren(node).find((child) => child.type === 'identifier')?.text ?? null;
    case 'qualified_name':
      return csharpTypeName(node.childForFieldName('name'));
    case 'nullable_type':
      return csharpTypeName(node.childForFieldName('type') ?? namedChildren(node)[0] ?? null);
    case 'array_type':
      return csharpTypeName(node.childForFieldName('type'));
    default:
      return null;
  }
}

/**
 * Reads a `using` directive.
 *
 * @param node - `using_directive` node.
 * @returns The import, or `null` when it names nothing.
 */
function readUsing(node: Node): ParsedImport | null {
  const alias = node.childForFieldName('name');
  const target = namedChildren(node)
    .filter((child) => child.id !== alias?.id)
    .find((child) => child.type === 'qualified_name' || child.type === 'identifier');
  if (target === undefined) {
    return null;
  }
  const specifier = target.text.replace(/\s+/g, '');
  const line = startLine(node);
  if (alias !== null) {
    const importedName = specifier.slice(specifier.lastIndexOf('.') + 1);
    return {
      specifier,
      target: 'type',
      syntax: 'import',
      line,
      bindings: [{ kind: 'named', importedName, localName: alias.text }],
    };
  }
  if (hasKeyword(node, 'static')) {
    return { specifier, target: 'type', syntax: 'import', line, bindings: [] };
  }
  return { specifier, target: 'namespace', syntax: 'import', line, bindings: [] };
}

/**
 * Whether a declaration has an exporting modifier.
 *
 * @param node - Declaration.
 * @returns `true` for `public`, `internal` and `protected` members.
 */
function isExported(node: Node): boolean {
  return namedChildren(node).some(
    (child) => child.type === 'modifier' && EXPORTED_MODIFIERS.has(child.text),
  );
}

/**
 * Parses a C# file. Never throws on syntax errors.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @param content - File text.
 * @returns Namespace, `using` directives, types and members with their calls.
 * @throws Error if {@link prepareCSharp} has not completed.
 */
export function parseCSharp(filePath: RelPath, content: string): ParsedFile {
  if (runtime === undefined) {
    throw new Error('The C# grammar is not loaded; call prepareCSharp() first.');
  }
  const tree = runtime.parser.parse(content);
  if (tree === null) {
    return { filePath, imports: [], functions: [], exports: [], namespace: '', types: [] };
  }
  try {
    let fileNamespace: string | undefined;
    const imports: ParsedImport[] = [];
    const types: ParsedType[] = [];
    const drafts: FunctionDraft[] = [];

    /**
     * Reads a type declaration, its members and its nested types.
     *
     * @param node - Type declaration.
     * @param namespace - Enclosing namespace.
     * @param outer - Qualified name of the enclosing type, if nested.
     */
    const readType = (node: Node, namespace: string, outer: string | undefined): void => {
      const name = node.childForFieldName('name')?.text;
      if (name === undefined) {
        return;
      }
      const qualified = outer === undefined ? name : `${outer}.${name}`;
      const isInterface = node.type === 'interface_declaration';
      const baseList = namedChildren(node).find((child) => child.type === 'base_list');
      const bases = (baseList === undefined ? [] : namedChildren(baseList))
        .map(csharpTypeName)
        .filter((base): base is string => base !== null);
      const fields: Record<string, string> = {};
      // Positional record parameters are properties.
      const parameters = namedChildren(node).find((child) => child.type === 'parameter_list');
      for (const parameter of parameters === undefined ? [] : namedChildren(parameters)) {
        const parameterName = parameter.childForFieldName('name')?.text;
        const parameterType = csharpTypeName(parameter.childForFieldName('type'));
        if (parameterName !== undefined && parameterType !== null) {
          fields[parameterName] = parameterType;
        }
      }
      types.push({ name, namespace, bases, fields });

      const body = node.childForFieldName('body');
      const members = body === null ? [] : namedChildren(body);
      for (const member of members) {
        if (member.type === 'field_declaration') {
          const declaration = namedChildren(member).find(
            (child) => child.type === 'variable_declaration',
          );
          const fieldType = csharpTypeName(declaration?.childForFieldName('type') ?? null);
          for (const declarator of declaration === undefined ? [] : namedChildren(declaration)) {
            const fieldName = declarator.childForFieldName('name')?.text;
            if (
              declarator.type === 'variable_declarator' &&
              fieldName !== undefined &&
              fieldType !== null
            ) {
              fields[fieldName] = fieldType;
            }
          }
        } else if (member.type === 'property_declaration') {
          const propertyName = member.childForFieldName('name')?.text;
          const propertyType = csharpTypeName(member.childForFieldName('type'));
          if (propertyName !== undefined && propertyType !== null) {
            fields[propertyName] = propertyType;
          }
        }
      }
      for (const member of members) {
        if (TYPE_DECLARATIONS.has(member.type)) {
          readType(member, namespace, qualified);
          continue;
        }
        let memberName: string | undefined;
        if (member.type === 'constructor_declaration') {
          memberName = CONSTRUCTOR_NAME;
        } else if (member.type === 'method_declaration') {
          memberName = member.childForFieldName('name')?.text;
        } else if (member.type === 'property_declaration') {
          // Only properties with code (accessor bodies or `=> expression`).
          const hasCode =
            member.childForFieldName('value')?.type === 'arrow_expression_clause' ||
            namedChildren(member).some((child) => child.type === 'arrow_expression_clause') ||
            /\{[^}]*\b(get|set|init)\s*(\{|=>)/.test(member.text);
          memberName = hasCode ? member.childForFieldName('name')?.text : undefined;
        }
        if (memberName === undefined) {
          continue;
        }
        drafts.push({
          fn: {
            name: memberName,
            qualifiedName: `${qualified}.${memberName}`,
            className: name,
            functionKind: 'method',
            line: startLine(member),
            endLine: endLine(member),
            exported: isInterface || isExported(member),
          },
          calls: [],
          variables: new Map(),
          fields,
          startIndex: member.startIndex,
          endIndex: member.endIndex,
        });
      }
    };

    /**
     * Reads the declarations of a compilation unit or namespace body.
     *
     * @param nodes - Declarations, in source order.
     * @param namespace - Enclosing namespace (empty for the global one).
     */
    const readDeclarations = (nodes: readonly Node[], namespace: string): void => {
      let current = namespace;
      for (const node of nodes) {
        if (node.type === 'using_directive') {
          const parsed = readUsing(node);
          if (parsed !== null) {
            imports.push(parsed);
          }
        } else if (
          node.type === 'namespace_declaration' ||
          node.type === 'file_scoped_namespace_declaration'
        ) {
          const name = (node.childForFieldName('name')?.text ?? '').replace(/\s+/g, '');
          const full =
            current === '' || node.type === 'file_scoped_namespace_declaration'
              ? name
              : `${current}.${name}`;
          fileNamespace ??= full;
          if (node.type === 'file_scoped_namespace_declaration') {
            current = full; // Applies to the rest of the file.
          } else {
            const body = node.childForFieldName('body');
            readDeclarations(body === null ? [] : namedChildren(body), full);
          }
        } else if (TYPE_DECLARATIONS.has(node.type) || node.type === 'enum_declaration') {
          readType(node, current, undefined);
        }
      }
    };

    readDeclarations(namedChildren(tree.rootNode), '');

    sortDrafts(drafts);
    for (const capture of runtime.body.captures(tree.rootNode)) {
      const draft = findEnclosingDraft(drafts, capture.node.startIndex);
      if (draft !== undefined) {
        readBodyNode(capture.name, capture.node, draft);
      }
    }

    return {
      filePath,
      imports,
      functions: toParsedFunctions(drafts),
      exports: [],
      namespace: fileNamespace ?? '',
      types,
    };
  } finally {
    tree.delete(); // Syntax trees live in WASM memory and must be freed.
  }
}

/**
 * Infers the type of an expression from what the member knows.
 *
 * @param node - Expression.
 * @param draft - Enclosing member.
 * @returns The type name, or `null`.
 */
function expressionType(node: Node | null, draft: FunctionDraft): string | null {
  if (node === null) {
    return null;
  }
  switch (node.type) {
    case 'object_creation_expression':
    case 'cast_expression':
      return csharpTypeName(node.childForFieldName('type'));
    case 'identifier':
      return draft.variables.get(node.text) ?? draft.fields[node.text] ?? null;
    case 'parenthesized_expression':
      return expressionType(namedChildren(node)[0] ?? null, draft);
    default:
      return null;
  }
}

/**
 * Records a declaration or a call found in a member.
 *
 * @param kind - Capture name of the body query.
 * @param node - Captured node.
 * @param draft - Enclosing member.
 */
function readBodyNode(kind: string, node: Node, draft: FunctionDraft): void {
  switch (kind) {
    case 'param': {
      const name = node.childForFieldName('name')?.text;
      const type = csharpTypeName(node.childForFieldName('type'));
      if (name !== undefined && type !== null) {
        draft.variables.set(name, type);
      }
      return;
    }
    case 'for': {
      const name = node.childForFieldName('left');
      const type = csharpTypeName(node.childForFieldName('type'));
      if (name?.type === 'identifier' && type !== null) {
        draft.variables.set(name.text, type);
      }
      return;
    }
    case 'local': {
      const declaration = namedChildren(node).find(
        (child) => child.type === 'variable_declaration',
      );
      if (declaration === undefined) {
        return;
      }
      const declared = csharpTypeName(declaration.childForFieldName('type'));
      for (const declarator of namedChildren(declaration)) {
        if (declarator.type !== 'variable_declarator') {
          continue;
        }
        const nameNode = declarator.childForFieldName('name');
        const value = namedChildren(declarator).find((child) => child.id !== nameNode?.id) ?? null;
        const type = declared ?? expressionType(value, draft);
        if (nameNode !== null && type !== null) {
          draft.variables.set(nameNode.text, type);
        }
      }
      return;
    }
    case 'new': {
      const type = csharpTypeName(node.childForFieldName('type'));
      if (type !== null) {
        draft.calls.push({
          kind: 'member',
          receiverType: type,
          name: CONSTRUCTOR_NAME,
          line: startLine(node),
        });
      }
      return;
    }
    case 'call': {
      const call = readCall(node, draft);
      if (call !== null) {
        draft.calls.push(call);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Name of a member written as `Name` or `Name<T>`.
 *
 * @param node - Name node.
 * @returns The name, or `undefined`.
 */
function memberName(node: Node | null): string | undefined {
  if (node === null) {
    return undefined;
  }
  return node.type === 'generic_name'
    ? namedChildren(node).find((child) => child.type === 'identifier')?.text
    : node.text;
}

/**
 * Describes a call whose receiver is an expression.
 *
 * @param receiver - Receiver expression.
 * @param name - Called member.
 * @param line - Line of the call.
 * @param draft - Enclosing member.
 * @returns The call, or `null` when the receiver cannot be described.
 */
function memberCall(
  receiver: Node,
  name: string,
  line: number,
  draft: FunctionDraft,
): ParsedCall | null {
  if (receiver.type === 'this' || receiver.type === 'base') {
    return { kind: 'this-member', name, line };
  }
  if (receiver.type === 'identifier') {
    const type = draft.variables.get(receiver.text) ?? draft.fields[receiver.text];
    return type === undefined
      ? { kind: 'member', receiver: receiver.text, name, line }
      : { kind: 'member', receiver: receiver.text, receiverType: type, name, line };
  }
  if (
    receiver.type === 'member_access_expression' &&
    receiver.childForFieldName('expression')?.type === 'this'
  ) {
    const field = receiver.childForFieldName('name')?.text;
    const owner = draft.fn.className;
    if (field === undefined || owner === undefined) {
      return null;
    }
    const type = draft.fields[field];
    return type === undefined
      ? {
          kind: 'member',
          receiver: receiver.text,
          receiverType: owner,
          receiverField: field,
          name,
          line,
        }
      : { kind: 'member', receiver: receiver.text, receiverType: type, name, line };
  }
  const type = expressionType(receiver, draft);
  return type === null ? null : { kind: 'member', receiverType: type, name, line };
}

/**
 * Describes an invocation.
 *
 * @param node - `invocation_expression` node.
 * @param draft - Enclosing member.
 * @returns The call, or `null` when it cannot be described.
 */
function readCall(node: Node, draft: FunctionDraft): ParsedCall | null {
  const callee = node.childForFieldName('function');
  const line = startLine(node);
  if (callee === null) {
    return null;
  }
  if (callee.type === 'identifier' || callee.type === 'generic_name') {
    const name = memberName(callee);
    return name === undefined ? null : { kind: 'this-member', name, line };
  }
  if (callee.type === 'member_access_expression') {
    const receiver = callee.childForFieldName('expression');
    const name = memberName(callee.childForFieldName('name'));
    return receiver === null || name === undefined ? null : memberCall(receiver, name, line, draft);
  }
  if (callee.type === 'conditional_access_expression') {
    // `x?.Save()`
    const receiver = callee.childForFieldName('condition');
    const binding = namedChildren(callee).find(
      (child) => child.type === 'member_binding_expression',
    );
    const name = memberName(binding?.childForFieldName('name') ?? null);
    return receiver === null || name === undefined ? null : memberCall(receiver, name, line, draft);
  }
  return null;
}
