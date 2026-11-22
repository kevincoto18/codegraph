/**
 * Python parser: Tree-sitter syntax tree → neutral {@link ParsedFile}.
 */
import type { Node, Parser } from '@vscode/tree-sitter-wasm';
import { Query } from '@vscode/tree-sitter-wasm';

import type { RelPath } from '../../shared';
import { createTreeSitterParser, loadTreeSitterLanguage } from './treeSitter';
import type {
  ImportBinding,
  ParsedCall,
  ParsedExport,
  ParsedFile,
  ParsedFunction,
  ParsedImport,
} from './types';

/** Grammar of Python in `@vscode/tree-sitter-wasm`. */
const PYTHON_GRAMMAR = 'tree-sitter-python.wasm';

/** Receivers that mean "this object" inside a method. */
const SELF_NAMES: ReadonlySet<string> = new Set(['self', 'cls']);

/** Query matching every call expression; evaluated inside the WASM engine. */
const CALLS_QUERY = '(call) @call';

/** Loaded parser and queries. */
interface PythonRuntime {
  readonly parser: Parser;
  readonly calls: Query;
}

let runtime: PythonRuntime | undefined;

/**
 * Loads the Python grammar; must complete before {@link parsePython} is called.
 *
 * @returns Resolves when the parser is ready.
 */
export async function preparePython(): Promise<void> {
  if (runtime === undefined) {
    const language = await loadTreeSitterLanguage(PYTHON_GRAMMAR);
    runtime = { parser: createTreeSitterParser(language), calls: new Query(language, CALLS_QUERY) };
  }
}

/** A function being collected, with the source range its calls come from. */
interface FunctionDraft {
  readonly fn: Omit<ParsedFunction, 'calls'>;
  readonly calls: ParsedCall[];
  /** Start offset of the code whose calls belong to the function. */
  readonly startIndex: number;
  /** End offset (exclusive) of that code. */
  readonly endIndex: number;
}

/**
 * Finds the function whose range contains an offset.
 *
 * @param drafts - Functions sorted by start offset, with disjoint ranges.
 * @param index - Source offset.
 * @returns The function, or `undefined` for code outside every function.
 */
function findEnclosing(drafts: readonly FunctionDraft[], index: number): FunctionDraft | undefined {
  let low = 0;
  let high = drafts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const draft = drafts[middle];
    if (draft === undefined) {
      return undefined;
    }
    if (index < draft.startIndex) {
      high = middle - 1;
    } else if (index >= draft.endIndex) {
      low = middle + 1;
    } else {
      return draft;
    }
  }
  return undefined;
}

/**
 * Returns the 1-based line where a node starts.
 *
 * @param node - Syntax node.
 * @returns The line.
 */
function startLine(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * Lists the named children of a node, skipping missing entries.
 *
 * @param node - Syntax node.
 * @returns The named children.
 */
function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

/**
 * Reads the module path of an import (`a.b`, `.a`, `..`).
 *
 * @param node - `dotted_name` or `relative_import` node.
 * @returns The module path as written.
 */
function modulePathOf(node: Node): string {
  return node.text.replace(/\s+/g, '');
}

/**
 * Joins a module path and a name imported from it (`pkg` + `mod` → `pkg.mod`,
 * `.` + `mod` → `.mod`).
 *
 * @param modulePath - Module path.
 * @param name - Imported name.
 * @returns The submodule path.
 */
function joinModule(modulePath: string, name: string): string {
  return modulePath.endsWith('.') ? `${modulePath}${name}` : `${modulePath}.${name}`;
}

/**
 * Collects the imports of an `import a`, `import a.b as c` statement.
 *
 * @param node - `import_statement` node.
 * @returns One import per module.
 */
function collectImportStatement(node: Node): ParsedImport[] {
  return node.childrenForFieldName('name').flatMap((nameNode): ParsedImport[] => {
    if (nameNode === null) {
      return [];
    }
    const aliased = nameNode.type === 'aliased_import';
    const moduleNode = aliased ? nameNode.childForFieldName('name') : nameNode;
    if (moduleNode === null) {
      return [];
    }
    const specifier = modulePathOf(moduleNode);
    const alias = aliased ? nameNode.childForFieldName('alias')?.text : undefined;
    // `import a` binds `a`; `import a.b` binds only the top package, which cannot
    // be resolved to one file, so it only records the dependency.
    const localName = alias ?? (specifier.includes('.') ? undefined : specifier);
    const bindings: ImportBinding[] =
      localName === undefined ? [] : [{ kind: 'namespace', importedName: '*', localName }];
    return [{ specifier, syntax: 'import', line: startLine(node), bindings }];
  });
}

/**
 * Collects the imports of a `from m import a, b as c` statement. Each name
 * may be a symbol of `m` or a submodule `m.a`, so both are recorded; the
 * linker keeps whichever resolves to a file.
 *
 * @param node - `import_from_statement` node.
 * @returns The imports.
 */
function collectImportFrom(node: Node): ParsedImport[] {
  const moduleNode = node.childForFieldName('module_name');
  if (moduleNode === null) {
    return [];
  }
  const modulePath = modulePathOf(moduleNode);
  const line = startLine(node);
  const named: ImportBinding[] = [];
  const submodules: ParsedImport[] = [];
  for (const nameNode of node.childrenForFieldName('name')) {
    if (nameNode === null) {
      continue;
    }
    const aliased = nameNode.type === 'aliased_import';
    const importedName = (aliased ? nameNode.childForFieldName('name') : nameNode)?.text;
    if (importedName === undefined) {
      continue;
    }
    const localName =
      (aliased ? nameNode.childForFieldName('alias')?.text : undefined) ?? importedName;
    named.push({ kind: 'named', importedName, localName });
    submodules.push({
      specifier: joinModule(modulePath, importedName),
      syntax: 'import',
      line,
      bindings: [{ kind: 'namespace', importedName: '*', localName }],
    });
  }
  return [{ specifier: modulePath, syntax: 'import', line, bindings: named }, ...submodules];
}

/**
 * Converts a call expression into a call site.
 *
 * @param node - `call` node.
 * @returns The call, or `null` for shapes that cannot be resolved statically.
 */
function toCall(node: Node): ParsedCall | null {
  const callee = node.childForFieldName('function');
  if (callee === null) {
    return null;
  }
  if (callee.type === 'identifier') {
    return { kind: 'identifier', name: callee.text, line: startLine(node) };
  }
  if (callee.type !== 'attribute') {
    return null;
  }
  const receiver = callee.childForFieldName('object');
  const name = callee.childForFieldName('attribute')?.text;
  if (receiver?.type !== 'identifier' || name === undefined) {
    return null;
  }
  return SELF_NAMES.has(receiver.text)
    ? { kind: 'this-member', name, line: startLine(node) }
    : { kind: 'member', receiver: receiver.text, name, line: startLine(node) };
}

/**
 * Parses one Python file.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @param content - File text.
 * @returns Imports, functions (top-level functions, methods and lambdas
 *   assigned at the top level), calls and exports (every top-level function
 *   and class). Nested functions are not nodes: their calls belong to the
 *   enclosing function. Syntax errors never throw.
 * @throws Error if {@link preparePython} has not completed.
 */
export function parsePython(filePath: RelPath, content: string): ParsedFile {
  if (runtime === undefined) {
    throw new Error('The Python grammar is not loaded; call preparePython() first.');
  }
  const tree = runtime.parser.parse(content);
  if (tree === null) {
    return { filePath, imports: [], functions: [], exports: [] };
  }
  try {
    const imports: ParsedImport[] = [];
    const drafts: FunctionDraft[] = [];
    const exports: ParsedExport[] = [];

    /**
     * Records a function and walks its body for calls.
     *
     * @param node - `function_definition` node.
     * @param className - Enclosing class, for methods.
     * @param exported - Whether the function or its class is public.
     */
    const addFunction = (node: Node, className: string | undefined, exported: boolean): void => {
      const name = node.childForFieldName('name')?.text;
      if (name === undefined) {
        return;
      }
      const body = node.childForFieldName('body');
      drafts.push({
        fn: {
          name,
          qualifiedName: className === undefined ? name : `${className}.${name}`,
          ...(className === undefined ? {} : { className }),
          functionKind: className === undefined ? 'function' : 'method',
          line: startLine(node),
          endLine: node.endPosition.row + 1,
          exported,
        },
        calls: [],
        // Calls in the body (nested functions and lambdas included) belong here.
        startIndex: (body ?? node).startIndex,
        endIndex: (body ?? node).endIndex,
      });
    };

    /**
     * Unwraps `@decorator` definitions.
     *
     * @param node - Statement node.
     * @returns The decorated definition, or the node itself.
     */
    const definitionOf = (node: Node): Node =>
      node.type === 'decorated_definition' ? (node.childForFieldName('definition') ?? node) : node;

    for (const statement of namedChildren(tree.rootNode)) {
      const definition = definitionOf(statement);
      switch (definition.type) {
        case 'import_statement':
          imports.push(...collectImportStatement(definition));
          break;
        case 'import_from_statement':
          imports.push(...collectImportFrom(definition));
          break;
        case 'function_definition': {
          const name = definition.childForFieldName('name')?.text;
          if (name !== undefined) {
            addFunction(definition, undefined, !name.startsWith('_'));
            exports.push({ exportedName: name, localName: name });
          }
          break;
        }
        case 'class_definition': {
          const className = definition.childForFieldName('name')?.text;
          const body = definition.childForFieldName('body');
          if (className === undefined || body === null) {
            break;
          }
          exports.push({ exportedName: className, localName: className });
          for (const member of namedChildren(body)) {
            const method = definitionOf(member);
            if (method.type === 'function_definition') {
              addFunction(method, className, !className.startsWith('_'));
            }
          }
          break;
        }
        case 'expression_statement': {
          // `name = lambda ...:` at the top level behaves like a function.
          const assignment = namedChildren(definition)[0];
          const left = assignment?.childForFieldName('left');
          const right = assignment?.childForFieldName('right');
          if (
            assignment?.type === 'assignment' &&
            left?.type === 'identifier' &&
            right?.type === 'lambda'
          ) {
            drafts.push({
              fn: {
                name: left.text,
                qualifiedName: left.text,
                functionKind: 'arrow',
                line: startLine(assignment),
                endLine: assignment.endPosition.row + 1,
                exported: !left.text.startsWith('_'),
              },
              calls: [],
              startIndex: right.startIndex,
              endIndex: right.endIndex,
            });
            exports.push({ exportedName: left.text, localName: left.text });
          }
          break;
        }
        default:
          break;
      }
    }

    // Assign every call to its enclosing function with one query run in WASM,
    // instead of visiting each node from JavaScript.
    for (const capture of runtime.calls.captures(tree.rootNode)) {
      const draft = findEnclosing(drafts, capture.node.startIndex);
      const call = draft === undefined ? null : toCall(capture.node);
      if (call !== null) {
        draft?.calls.push(call);
      }
    }

    return {
      filePath,
      imports,
      functions: drafts.map((draft) => ({ ...draft.fn, calls: draft.calls })),
      exports,
    };
  } finally {
    tree.delete(); // Syntax trees live in WASM memory and must be freed.
  }
}
