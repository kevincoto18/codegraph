/**
 * Java parser built on Tree-sitter.
 *
 * Extracts the package, imports, types (with base types and field types) and
 * methods. Calls are typed with what the file says about their receiver:
 * parameters, local variables (`Repo r = …`, `var r = new Repo()`), fields
 * and `new Repo()`. The linker then resolves them by type (see `scope.ts`).
 */
import type { Node, Parser } from '@vscode/tree-sitter-wasm';
import { Query } from '@vscode/tree-sitter-wasm';

import type { RelPath } from '../../shared';
import { createTreeSitterParser, loadTreeSitterLanguage } from './treeSitter';
import type { FunctionDraft } from './treeSitterDrafts';
import {
  endLine,
  fieldChildren,
  findEnclosingDraft,
  hasKeyword,
  namedChildren,
  sortDrafts,
  startLine,
  toParsedFunctions,
} from './treeSitterDrafts';
import type { ParsedCall, ParsedFile, ParsedImport, ParsedType } from './types';

/** Grammar file shipped in `dist/grammars`. */
const JAVA_GRAMMAR = 'tree-sitter-java.wasm';

/** Name given to constructors, as in the other languages. */
export const CONSTRUCTOR_NAME = 'constructor';

/** Nodes read inside method bodies, in one query run. */
const BODY_QUERY = `
(formal_parameter) @param
(catch_formal_parameter) @param
(local_variable_declaration) @local
(enhanced_for_statement) @for
(method_invocation) @call
(object_creation_expression) @new
`;

/** Declarations of types. */
const TYPE_DECLARATIONS: ReadonlySet<string> = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
]);

/** Loaded grammar, parser and query. */
interface JavaRuntime {
  readonly parser: Parser;
  readonly body: Query;
}

let runtime: JavaRuntime | undefined;

/**
 * Loads the Java grammar (once). Must complete before {@link parseJava}.
 *
 * @returns Resolves when the parser is ready.
 */
export async function prepareJava(): Promise<void> {
  if (runtime === undefined) {
    const language = await loadTreeSitterLanguage(JAVA_GRAMMAR);
    runtime = { parser: createTreeSitterParser(language), body: new Query(language, BODY_QUERY) };
  }
}

/**
 * Simple name of a type written in the source (`List<User>` → `List`,
 * `a.b.Repo` → `Repo`, `Repo[]` → `Repo`).
 *
 * @param node - Type node.
 * @returns The name, or `null` for primitives, `var` and unknown shapes.
 */
export function javaTypeName(node: Node | null): string | null {
  if (node === null) {
    return null;
  }
  switch (node.type) {
    case 'type_identifier':
      return node.text === 'var' ? null : node.text;
    case 'generic_type':
      return javaTypeName(namedChildren(node)[0] ?? null);
    case 'scoped_type_identifier': {
      const parts = namedChildren(node);
      return javaTypeName(parts.at(-1) ?? null);
    }
    case 'array_type':
      return javaTypeName(node.childForFieldName('element'));
    default:
      return null;
  }
}

/**
 * Reads an import declaration.
 *
 * @param node - `import_declaration` node.
 * @returns The import.
 */
function readImport(node: Node): ParsedImport | null {
  const path = namedChildren(node).find(
    (child) => child.type === 'scoped_identifier' || child.type === 'identifier',
  );
  if (path === undefined) {
    return null;
  }
  const specifier = path.text.replace(/\s+/g, '');
  const wildcard = namedChildren(node).some((child) => child.type === 'asterisk');
  const line = startLine(node);
  if (hasKeyword(node, 'static')) {
    // `import static a.b.Util.trim` / `a.b.Util.*`: a dependency on the class.
    const typeName = wildcard ? specifier : specifier.slice(0, specifier.lastIndexOf('.'));
    return { specifier: typeName, target: 'type', syntax: 'import', line, bindings: [] };
  }
  if (wildcard) {
    return { specifier, target: 'namespace', syntax: 'import', line, bindings: [] };
  }
  const localName = specifier.slice(specifier.lastIndexOf('.') + 1);
  return {
    specifier,
    target: 'type',
    syntax: 'import',
    line,
    bindings: [{ kind: 'named', importedName: localName, localName }],
  };
}

/**
 * Lists the base types of a type declaration.
 *
 * @param node - Type declaration.
 * @returns Simple names of the superclass and interfaces.
 */
function readBases(node: Node): string[] {
  const bases: string[] = [];
  const superclass = node.childForFieldName('superclass');
  const superName = superclass === null ? null : javaTypeName(namedChildren(superclass)[0] ?? null);
  if (superName !== null) {
    bases.push(superName);
  }
  const interfaceLists = [
    node.childForFieldName('interfaces'),
    ...namedChildren(node).filter((child) => child.type === 'extends_interfaces'),
  ];
  for (const list of interfaceLists) {
    const types = list === null ? [] : namedChildren(namedChildren(list)[0] ?? list);
    for (const type of types) {
      const name = javaTypeName(type);
      if (name !== null) {
        bases.push(name);
      }
    }
  }
  return bases;
}

/**
 * Parses a Java file. Never throws on syntax errors: the grammar recovers and
 * whatever can be read is returned.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @param content - File text.
 * @returns Package, imports, types and methods with their calls.
 * @throws Error if {@link prepareJava} has not completed.
 */
export function parseJava(filePath: RelPath, content: string): ParsedFile {
  if (runtime === undefined) {
    throw new Error('The Java grammar is not loaded; call prepareJava() first.');
  }
  const tree = runtime.parser.parse(content);
  if (tree === null) {
    return { filePath, imports: [], functions: [], exports: [], namespace: '', types: [] };
  }
  try {
    let namespace = '';
    const imports: ParsedImport[] = [];
    const types: ParsedType[] = [];
    const drafts: FunctionDraft[] = [];

    /**
     * Reads a type declaration, its members and its nested types.
     *
     * @param node - Type declaration.
     * @param outer - Qualified name of the enclosing type, if nested.
     */
    const readType = (node: Node, outer: string | undefined): void => {
      const name = node.childForFieldName('name')?.text;
      const body = node.childForFieldName('body');
      if (name === undefined) {
        return;
      }
      const qualified = outer === undefined ? name : `${outer}.${name}`;
      const isInterface = node.type === 'interface_declaration';
      const fields: Record<string, string> = {};
      // Record components are fields.
      const components = node.childForFieldName('parameters');
      for (const component of components === null ? [] : namedChildren(components)) {
        const componentName = component.childForFieldName('name')?.text;
        const componentType = javaTypeName(component.childForFieldName('type'));
        if (componentName !== undefined && componentType !== null) {
          fields[componentName] = componentType;
        }
      }
      types.push({ name, namespace, bases: readBases(node), fields });

      const members =
        body === null
          ? []
          : namedChildren(body).flatMap((member) =>
              member.type === 'enum_body_declarations' ? namedChildren(member) : [member],
            );
      for (const member of members) {
        if (member.type === 'field_declaration' || member.type === 'constant_declaration') {
          const fieldType = javaTypeName(member.childForFieldName('type'));
          for (const declarator of fieldChildren(member, 'declarator')) {
            const fieldName = declarator.childForFieldName('name')?.text;
            if (fieldName !== undefined && fieldType !== null) {
              fields[fieldName] = fieldType;
            }
          }
        }
      }
      for (const member of members) {
        if (TYPE_DECLARATIONS.has(member.type)) {
          readType(member, qualified);
          continue;
        }
        const isConstructor =
          member.type === 'constructor_declaration' ||
          member.type === 'compact_constructor_declaration';
        if (member.type !== 'method_declaration' && !isConstructor) {
          continue;
        }
        const methodName = isConstructor
          ? CONSTRUCTOR_NAME
          : member.childForFieldName('name')?.text;
        if (methodName === undefined) {
          continue;
        }
        const modifiers = namedChildren(member).find((child) => child.type === 'modifiers');
        drafts.push({
          fn: {
            name: methodName,
            qualifiedName: `${qualified}.${methodName}`,
            className: name,
            functionKind: 'method',
            line: startLine(member),
            endLine: endLine(member),
            exported: isInterface || (modifiers?.text.split(/\s+/).includes('public') ?? false),
          },
          calls: [],
          variables: new Map(),
          fields,
          startIndex: member.startIndex,
          endIndex: member.endIndex,
        });
      }
    };

    for (const node of namedChildren(tree.rootNode)) {
      if (node.type === 'package_declaration') {
        namespace = (namedChildren(node)[0]?.text ?? '').replace(/\s+/g, '');
      } else if (node.type === 'import_declaration') {
        const parsed = readImport(node);
        if (parsed !== null) {
          imports.push(parsed);
        }
      } else if (TYPE_DECLARATIONS.has(node.type)) {
        readType(node, undefined);
      }
    }

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
      namespace,
      types,
    };
  } finally {
    tree.delete(); // Syntax trees live in WASM memory and must be freed.
  }
}

/**
 * Infers the type of an expression from what the method knows.
 *
 * @param node - Expression.
 * @param draft - Enclosing method.
 * @returns The type name, or `null`.
 */
function expressionType(node: Node | null, draft: FunctionDraft): string | null {
  if (node === null) {
    return null;
  }
  switch (node.type) {
    case 'object_creation_expression':
      return javaTypeName(node.childForFieldName('type'));
    case 'cast_expression':
      return javaTypeName(node.childForFieldName('type'));
    case 'identifier':
      return draft.variables.get(node.text) ?? draft.fields[node.text] ?? null;
    case 'parenthesized_expression':
      return expressionType(namedChildren(node)[0] ?? null, draft);
    default:
      return null;
  }
}

/**
 * Records a declaration or a call found in a method.
 *
 * @param kind - Capture name of the body query.
 * @param node - Captured node.
 * @param draft - Enclosing method.
 */
function readBodyNode(kind: string, node: Node, draft: FunctionDraft): void {
  switch (kind) {
    case 'param':
    case 'for': {
      const name = node.childForFieldName('name')?.text;
      const type = javaTypeName(node.childForFieldName('type'));
      if (name !== undefined && type !== null) {
        draft.variables.set(name, type);
      }
      return;
    }
    case 'local': {
      const declared = javaTypeName(node.childForFieldName('type'));
      for (const declarator of fieldChildren(node, 'declarator')) {
        const name = declarator.childForFieldName('name')?.text;
        const type = declared ?? expressionType(declarator.childForFieldName('value'), draft);
        if (name !== undefined && type !== null) {
          draft.variables.set(name, type);
        }
      }
      return;
    }
    case 'new': {
      const type = javaTypeName(node.childForFieldName('type'));
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
 * Describes a method invocation.
 *
 * @param node - `method_invocation` node.
 * @param draft - Enclosing method.
 * @returns The call, or `null` when its receiver cannot be described.
 */
function readCall(node: Node, draft: FunctionDraft): ParsedCall | null {
  const name = node.childForFieldName('name')?.text;
  if (name === undefined) {
    return null;
  }
  const line = startLine(node);
  const object = node.childForFieldName('object');
  if (object === null || object.type === 'this' || object.type === 'super') {
    return { kind: 'this-member', name, line };
  }
  if (object.type === 'identifier') {
    const type = draft.variables.get(object.text) ?? draft.fields[object.text];
    return type === undefined
      ? { kind: 'member', receiver: object.text, name, line }
      : { kind: 'member', receiver: object.text, receiverType: type, name, line };
  }
  if (object.type === 'field_access' && object.childForFieldName('object')?.type === 'this') {
    const field = object.childForFieldName('field')?.text;
    const owner = draft.fn.className;
    if (field === undefined || owner === undefined) {
      return null;
    }
    const type = draft.fields[field];
    return type === undefined
      ? {
          kind: 'member',
          receiver: object.text,
          receiverType: owner,
          receiverField: field,
          name,
          line,
        }
      : { kind: 'member', receiver: object.text, receiverType: type, name, line };
  }
  const type = expressionType(object, draft);
  return type === null ? null : { kind: 'member', receiverType: type, name, line };
}
