/**
 * Go parser built on Tree-sitter.
 *
 * A Go package is a folder, so the file's namespace is its folder. Extracts
 * imports (with their local package name), types (struct fields and
 * embedded types), functions and methods (whose class is the receiver
 * type). Calls are typed with what the file says about their receiver:
 * parameters, the method receiver, `x := T{}` / `&pkg.T{}`, `var x T`, and
 * function results (`x := pkg.New()`, read from the declared result type by
 * the linker). Calls are then resolved by package and type (see `scope.ts`).
 */
import { posix } from 'node:path';

import type { Node, Parser } from '@vscode/tree-sitter-wasm';
import { Query } from '@vscode/tree-sitter-wasm';

import type { RelPath } from '../../shared';
import { createTreeSitterParser, loadTreeSitterLanguage } from './treeSitter';
import type { FunctionDraft } from './treeSitterDrafts';
import {
  endLine,
  fieldChildren,
  findEnclosingDraft,
  namedChildren,
  sortDrafts,
  startLine,
  toParsedFunctions,
} from './treeSitterDrafts';
import { CALL_RESULT_PREFIX } from './scope';
import type { ParsedCall, ParsedFile, ParsedImport, ParsedType } from './types';

/** Grammar file shipped in `dist/grammars`. */
const GO_GRAMMAR = 'tree-sitter-go.wasm';

/** Nodes read inside function bodies, in one query run. */
const BODY_QUERY = `
(parameter_declaration) @param
(short_var_declaration) @short
(var_spec) @var
(call_expression) @call
`;

/** Loaded grammar, parser and query. */
interface GoRuntime {
  readonly parser: Parser;
  readonly body: Query;
}

let runtime: GoRuntime | undefined;

/**
 * Loads the Go grammar (once). Must complete before {@link parseGo}.
 *
 * @returns Resolves when the parser is ready.
 */
export async function prepareGo(): Promise<void> {
  if (runtime === undefined) {
    const language = await loadTreeSitterLanguage(GO_GRAMMAR);
    runtime = { parser: createTreeSitterParser(language), body: new Query(language, BODY_QUERY) };
  }
}

/**
 * Name of a type written in the source (`*Repo` → `Repo`, `db.Repo` →
 * `db.Repo`, `List[T]` → `List`).
 *
 * @param node - Type node.
 * @returns The name, or `null` for slices, maps, functions and unknown shapes.
 */
export function goTypeName(node: Node | null): string | null {
  if (node === null) {
    return null;
  }
  switch (node.type) {
    case 'type_identifier':
      return node.text;
    case 'pointer_type':
      return goTypeName(namedChildren(node)[0] ?? null);
    case 'qualified_type': {
      const pkg = node.childForFieldName('package')?.text;
      const name = node.childForFieldName('name')?.text;
      return pkg === undefined || name === undefined ? null : `${pkg}.${name}`;
    }
    case 'generic_type':
      return goTypeName(node.childForFieldName('type'));
    default:
      return null;
  }
}

/**
 * Local name a package is used by: its alias, or the last segment of its
 * path (skipping a `/v2` major-version suffix).
 *
 * @param path - Import path.
 * @returns The package name.
 */
export function goPackageName(path: string): string {
  const segments = path.split('/');
  const last = segments.at(-1) ?? path;
  return /^v\d+$/.test(last) && segments.length > 1 ? (segments.at(-2) ?? last) : last;
}

/**
 * Reads the import specs of an import declaration.
 *
 * @param node - `import_declaration` node.
 * @returns One import per spec.
 */
function readImports(node: Node): ParsedImport[] {
  const specs = namedChildren(node).flatMap((child) =>
    child.type === 'import_spec_list' ? namedChildren(child) : [child],
  );
  return specs.flatMap((spec): ParsedImport[] => {
    if (spec.type !== 'import_spec') {
      return [];
    }
    const path = spec.childForFieldName('path')?.text.replace(/^["`]|["`]$/g, '');
    if (path === undefined || path === '') {
      return [];
    }
    const alias = spec.childForFieldName('name')?.text;
    // `_` imports bind nothing; `.` imports are not resolved.
    const localName = alias ?? goPackageName(path);
    const bindings =
      localName === '_' || localName === '.'
        ? []
        : [{ kind: 'namespace' as const, importedName: '*', localName }];
    return [
      { specifier: path, target: 'package', syntax: 'import', line: startLine(spec), bindings },
    ];
  });
}

/**
 * Whether a Go name is exported (starts with an upper-case letter).
 *
 * @param name - Identifier.
 * @returns `true` for exported names.
 */
function isExportedName(name: string): boolean {
  const first = name.charAt(0);
  return first !== first.toLowerCase();
}

/**
 * Reads a struct type: field types and embedded types (whose methods are promoted).
 *
 * @param node - `struct_type` node.
 * @returns The fields and embedded types.
 */
function readStruct(node: Node): { fields: Record<string, string>; bases: string[] } {
  const fields: Record<string, string> = {};
  const bases: string[] = [];
  const list = namedChildren(node).find((child) => child.type === 'field_declaration_list');
  for (const field of list === undefined ? [] : namedChildren(list)) {
    if (field.type !== 'field_declaration') {
      continue;
    }
    const type = goTypeName(field.childForFieldName('type'));
    const names = fieldChildren(field, 'name');
    if (type === null) {
      continue;
    }
    if (names.length === 0) {
      bases.push(type);
    }
    for (const name of names) {
      fields[name.text] = type;
    }
  }
  return { fields, bases };
}

/**
 * Parses a Go file. Never throws on syntax errors.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @param content - File text.
 * @returns Package folder, imports, types and functions with their calls.
 * @throws Error if {@link prepareGo} has not completed.
 */
export function parseGo(filePath: RelPath, content: string): ParsedFile {
  if (runtime === undefined) {
    throw new Error('The Go grammar is not loaded; call prepareGo() first.');
  }
  const folder = posix.dirname(filePath);
  const namespace = folder === '.' ? '' : folder;
  const tree = runtime.parser.parse(content);
  if (tree === null) {
    return { filePath, imports: [], functions: [], exports: [], namespace, types: [] };
  }
  try {
    const imports: ParsedImport[] = [];
    const types: ParsedType[] = [];
    const drafts: FunctionDraft[] = [];
    /** Result type of the functions of this file, for `x := makeRepo()`. */
    const results = new Map<string, string>();

    for (const node of namedChildren(tree.rootNode)) {
      switch (node.type) {
        case 'import_declaration':
          imports.push(...readImports(node));
          break;
        case 'type_declaration':
          for (const spec of namedChildren(node)) {
            const name = spec.childForFieldName('name')?.text;
            const type = spec.childForFieldName('type');
            if (name === undefined) {
              continue;
            }
            const struct =
              type?.type === 'struct_type' ? readStruct(type) : { fields: {}, bases: [] };
            types.push({ name, namespace, ...struct });
            // Interface methods are nodes too, so calls through an interface are drawn.
            for (const element of type?.type === 'interface_type' ? namedChildren(type) : []) {
              const methodName = element.childForFieldName('name')?.text;
              if (element.type !== 'method_elem' || methodName === undefined) {
                continue;
              }
              drafts.push({
                fn: {
                  name: methodName,
                  qualifiedName: `${name}.${methodName}`,
                  className: name,
                  functionKind: 'method',
                  line: startLine(element),
                  endLine: endLine(element),
                  exported: isExportedName(methodName),
                },
                calls: [],
                variables: new Map(),
                fields: {},
                startIndex: element.startIndex,
                endIndex: element.endIndex,
              });
            }
          }
          break;
        case 'function_declaration':
        case 'method_declaration': {
          const name = node.childForFieldName('name')?.text;
          if (name === undefined) {
            continue;
          }
          const result = goTypeName(node.childForFieldName('result'));
          const receiver =
            node.type === 'method_declaration'
              ? namedChildren(node.childForFieldName('receiver') ?? node)[0]
              : undefined;
          const className =
            receiver === undefined ? undefined : goTypeName(receiver.childForFieldName('type'));
          if (node.type === 'function_declaration' && result !== null) {
            results.set(name, result);
          }
          drafts.push({
            fn: {
              name,
              qualifiedName:
                className === undefined || className === null ? name : `${className}.${name}`,
              ...(className === undefined || className === null ? {} : { className }),
              functionKind: className === undefined || className === null ? 'function' : 'method',
              line: startLine(node),
              endLine: endLine(node),
              exported: isExportedName(name),
              ...(result === null ? {} : { resultType: result }),
            },
            calls: [],
            variables: new Map(),
            fields: {},
            startIndex: node.startIndex,
            endIndex: node.endIndex,
          });
          break;
        }
        default:
          break;
      }
    }

    sortDrafts(drafts);
    for (const capture of runtime.body.captures(tree.rootNode)) {
      const draft = findEnclosingDraft(drafts, capture.node.startIndex);
      if (draft !== undefined) {
        readBodyNode(capture.name, capture.node, draft, results);
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
 * Infers the type of an expression.
 *
 * @param node - Expression.
 * @param draft - Enclosing function.
 * @param results - Result types of the file's functions.
 * @returns The type name, or `null`.
 */
function expressionType(
  node: Node | null,
  draft: FunctionDraft,
  results: ReadonlyMap<string, string>,
): string | null {
  if (node === null) {
    return null;
  }
  switch (node.type) {
    case 'composite_literal':
      return goTypeName(node.childForFieldName('type'));
    case 'unary_expression':
      return expressionType(node.childForFieldName('operand'), draft, results);
    case 'identifier':
      return draft.variables.get(node.text) ?? null;
    case 'call_expression': {
      const callee = node.childForFieldName('function');
      if (callee?.type === 'identifier') {
        const known = results.get(callee.text);
        if (known !== undefined) {
          return known;
        }
        // A function of another file of the package: the linker reads its result type.
        return `${CALL_RESULT_PREFIX}${callee.text}`;
      }
      if (callee?.type === 'selector_expression') {
        const pkg = callee.childForFieldName('operand');
        const name = callee.childForFieldName('field')?.text;
        // `pkg.F()` results are read by the linker; `x.Method()` results are unknown.
        if (pkg?.type === 'identifier' && name !== undefined && !draft.variables.has(pkg.text)) {
          return `${CALL_RESULT_PREFIX}${pkg.text}.${name}`;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Records a declaration or a call found in a function.
 *
 * @param kind - Capture name of the body query.
 * @param node - Captured node.
 * @param draft - Enclosing function.
 * @param results - Result types of the file's functions.
 */
function readBodyNode(
  kind: string,
  node: Node,
  draft: FunctionDraft,
  results: ReadonlyMap<string, string>,
): void {
  switch (kind) {
    case 'param':
    case 'var': {
      const declared = goTypeName(node.childForFieldName('type'));
      const values = namedChildren(node.childForFieldName('value') ?? node).filter(
        (child) => child.type !== 'identifier' || kind === 'var',
      );
      fieldChildren(node, 'name').forEach((name, index) => {
        const type =
          declared ??
          (kind === 'var' ? expressionType(values[index] ?? null, draft, results) : null);
        if (type !== null) {
          draft.variables.set(name.text, type);
        }
      });
      return;
    }
    case 'short': {
      const names = namedChildren(node.childForFieldName('left') ?? node);
      const values = namedChildren(node.childForFieldName('right') ?? node);
      names.forEach((name, index) => {
        const type = expressionType(values[index] ?? null, draft, results);
        if (name.type === 'identifier' && type !== null) {
          draft.variables.set(name.text, type);
        }
      });
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
 * Describes a call expression.
 *
 * @param node - `call_expression` node.
 * @param draft - Enclosing function.
 * @returns The call, or `null` when it cannot be described.
 */
function readCall(node: Node, draft: FunctionDraft): ParsedCall | null {
  const callee = node.childForFieldName('function');
  const line = startLine(node);
  if (callee?.type === 'identifier') {
    return { kind: 'identifier', name: callee.text, line };
  }
  if (callee?.type !== 'selector_expression') {
    return null;
  }
  const operand = callee.childForFieldName('operand');
  const name = callee.childForFieldName('field')?.text;
  if (operand === null || name === undefined) {
    return null;
  }
  if (operand.type === 'identifier') {
    const type = draft.variables.get(operand.text);
    return type === undefined
      ? { kind: 'member', receiver: operand.text, name, line }
      : { kind: 'member', receiver: operand.text, receiverType: type, name, line };
  }
  if (operand.type === 'selector_expression') {
    // `s.repo.Save()`: a method of the type of field `repo` of `s`.
    const owner = operand.childForFieldName('operand');
    const field = operand.childForFieldName('field')?.text;
    const ownerType = owner?.type === 'identifier' ? draft.variables.get(owner.text) : undefined;
    return ownerType === undefined || field === undefined
      ? null
      : {
          kind: 'member',
          receiver: operand.text,
          receiverType: ownerType,
          receiverField: field,
          name,
          line,
        };
  }
  return null;
}
