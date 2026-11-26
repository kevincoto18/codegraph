/**
 * Python parser: Tree-sitter syntax tree → neutral {@link ParsedFile}, plus
 * the Python details the linker needs to resolve calls with types (classes,
 * signatures and every use of a name; see `pythonModel.ts`).
 */
import type { Node, Parser } from '@vscode/tree-sitter-wasm';

import type { RelPath } from '../../shared';
import type { PyClass, PyExpr, PyFunctionInfo, PyModuleInfo, PyUse } from './pythonModel';
import { createTreeSitterParser, loadTreeSitterLanguage } from './treeSitter';
import type {
  ImportBinding,
  ParsedExport,
  ParsedFile,
  ParsedFunction,
  ParsedImport,
} from './types';

/** Grammar of Python in `@vscode/tree-sitter-wasm`. */
const PYTHON_GRAMMAR = 'tree-sitter-python.wasm';

/** Value of a name that cannot be known. */
const UNKNOWN: PyExpr = { t: 'unknown' };

/** Most alternatives kept for a variable assigned in several places. */
const MAX_ALTERNATIVES = 4;

/** Statements whose blocks still belong to the module level. */
const MODULE_BLOCKS: ReadonlySet<string> = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'try_statement',
  'except_clause',
  'except_group_clause',
  'finally_clause',
  'with_statement',
  'block',
]);

/** Decorators that turn a method into an attribute read. */
const PROPERTY_DECORATORS: ReadonlySet<string> = new Set([
  'property',
  'cached_property',
  'functools.cached_property',
]);

/** Built-in decorators that change how a method is called, not code of the project. */
const BUILTIN_DECORATORS: ReadonlySet<string> = new Set([
  'staticmethod',
  'classmethod',
  'property',
]);

/** Assignment targets that hold several names (`a, b = …`, `[a, *rest] = …`). */
const PATTERN_TARGETS: ReadonlySet<string> = new Set([
  'pattern_list',
  'tuple_pattern',
  'list_pattern',
  'tuple',
  'list',
  'parenthesized_expression',
  'list_splat_pattern',
]);

/** Comprehension node types (their `for` clauses bind variables). */
const COMPREHENSIONS: ReadonlySet<string> = new Set([
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
]);

let parser: Parser | undefined;

/**
 * Loads the Python grammar; must complete before {@link parsePython} is called.
 *
 * @returns Resolves when the parser is ready.
 */
export async function preparePython(): Promise<void> {
  parser ??= createTreeSitterParser(await loadTreeSitterLanguage(PYTHON_GRAMMAR));
}

/** Local variables of a function: name → possible values. */
type Env = Map<string, PyExpr>;

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
 * Unwraps a `@decorator` definition.
 *
 * @param node - Statement node.
 * @returns The decorated definition and its decorators.
 */
function unwrapDecorated(node: Node): { definition: Node; decorators: Node[] } {
  if (node.type !== 'decorated_definition') {
    return { definition: node, decorators: [] };
  }
  return {
    definition: node.childForFieldName('definition') ?? node,
    decorators: namedChildren(node).filter((child) => child.type === 'decorator'),
  };
}

/**
 * Text of a decorator without its arguments (`functools.wraps(fn)` → `functools.wraps`).
 *
 * @param decorator - `decorator` node.
 * @returns The decorator name.
 */
function decoratorName(decorator: Node): string {
  const expression = namedChildren(decorator)[0];
  if (expression === undefined) {
    return '';
  }
  const callee = expression.type === 'call' ? expression.childForFieldName('function') : expression;
  return callee?.text ?? '';
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
  if (namedChildren(node).some((child) => child.type === 'wildcard_import')) {
    return [{ specifier: modulePath, syntax: 'import', line, bindings: [], star: true }];
  }
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
  return [
    { specifier: modulePath, syntax: 'import', line, bindings: named, lookupOnly: true },
    ...submodules,
  ];
}

/**
 * Combines possible values of a variable.
 *
 * @param values - Values, possibly unions themselves.
 * @returns One value.
 */
function anyOf(values: readonly PyExpr[]): PyExpr {
  const flat = values.flatMap((value) => (value.t === 'any' ? value.of : [value]));
  const known = flat.filter((value) => value.t !== 'unknown');
  if (known.length === 0) {
    return UNKNOWN;
  }
  const unique = [...new Map(known.map((value) => [JSON.stringify(value), value])).values()];
  return unique.length === 1
    ? (unique[0] ?? UNKNOWN)
    : { t: 'any', of: unique.slice(-MAX_ALTERNATIVES) };
}

/**
 * Text of an annotation, without the quotes of a string annotation.
 *
 * @param node - Annotation node (`type`).
 * @returns The annotation text.
 */
function annotationText(node: Node): string {
  return node.text.replace(/^(['"])(.*)\1$/s, '$2').trim();
}

/**
 * Collects everything a module tells about itself while walking it once.
 */
class ModuleWalker {
  public readonly imports: ParsedImport[] = [];
  public readonly functions: ParsedFunction[] = [];
  public readonly exports: ParsedExport[] = [];
  public readonly classes: PyClass[] = [];
  public readonly variables: Record<string, PyExpr> = {};
  public readonly moduleUses: PyUse[] = [];
  public all: string[] | undefined;
  /** Top-level names already defined (a redefinition in another branch is skipped). */
  private readonly topLevelNames = new Set<string>();
  /** Uses of property setters and deleters, merged into the getter (by qualified name). */
  public readonly accessorUses = new Map<string, PyUse[]>();

  /**
   * Walks the statements of the module level, including the blocks of
   * module-level `if` / `try` / `with` statements.
   *
   * @param statements - Statement nodes.
   */
  public walkModule(statements: readonly Node[]): void {
    const env: Env = new Map();
    for (const statement of statements) {
      this.moduleStatement(statement, env);
    }
  }

  /**
   * Handles one module-level statement.
   *
   * @param statement - Statement node.
   * @param env - Module scope (only used to read module-level loops and `with`).
   */
  private moduleStatement(statement: Node, env: Env): void {
    const { definition, decorators } = unwrapDecorated(statement);
    switch (definition.type) {
      case 'import_statement':
        this.imports.push(...collectImportStatement(definition));
        return;
      case 'import_from_statement':
        this.imports.push(...collectImportFrom(definition));
        return;
      case 'future_import_statement':
        return;
      case 'function_definition': {
        const name = definition.childForFieldName('name')?.text;
        if (name === undefined || this.topLevelNames.has(name) || this.isOverload(decorators)) {
          return;
        }
        this.topLevelNames.add(name);
        this.addFunction(definition, decorators, undefined, new Map());
        this.exports.push({ exportedName: name, localName: name });
        return;
      }
      case 'class_definition':
        this.addClass(definition, decorators, undefined);
        return;
      case 'expression_statement':
        this.moduleExpression(definition, env);
        return;
      default:
        break;
    }
    if (MODULE_BLOCKS.has(definition.type)) {
      // The condition, `with` items and `except` types are module-level code too.
      for (const child of namedChildren(definition)) {
        if (child.type === 'block' || MODULE_BLOCKS.has(child.type)) {
          for (const inner of child.type === 'block' ? namedChildren(child) : [child]) {
            this.moduleStatement(inner, env);
          }
        } else {
          this.visit(child, env, this.moduleUses);
        }
      }
      return;
    }
    this.visit(definition, env, this.moduleUses);
  }

  /**
   * Handles a module-level expression statement: variables, lambdas,
   * `__all__` and module-level calls.
   *
   * @param statement - `expression_statement` node.
   * @param env - Module scope.
   */
  private moduleExpression(statement: Node, env: Env): void {
    const assignment = namedChildren(statement)[0];
    const left = assignment?.type === 'assignment' ? assignment.childForFieldName('left') : null;
    const right = assignment?.childForFieldName('right') ?? null;
    const annotation = assignment?.childForFieldName('type') ?? null;
    if (assignment === undefined || left?.type !== 'identifier') {
      this.visit(statement, env, this.moduleUses);
      return;
    }
    const name = left.text;
    if (right?.type === 'lambda') {
      if (!this.topLevelNames.has(name)) {
        this.topLevelNames.add(name);
        this.addLambda(name, assignment, right);
        this.exports.push({ exportedName: name, localName: name });
      }
      return;
    }
    if (name === '__all__' && right !== null) {
      this.all = namedChildren(right)
        .filter((item) => item.type === 'string')
        .map((item) => item.text.replace(/^['"]|['"]$/g, ''));
      return;
    }
    if (right !== null) {
      this.visit(right, env, this.moduleUses);
    }
    const value =
      annotation === null
        ? right === null
          ? UNKNOWN
          : this.exprOf(right, env)
        : ({ t: 'ann', text: annotationText(annotation) } as const);
    this.variables[name] = value;
    if (!this.topLevelNames.has(name)) {
      this.exports.push({ exportedName: name, localName: name });
    }
  }

  /**
   * Whether a definition is an `@overload` stub.
   *
   * @param decorators - Its decorators.
   * @returns `true` for overload stubs.
   */
  private isOverload(decorators: readonly Node[]): boolean {
    return decorators.some((decorator) => /(^|\.)overload$/.test(decoratorName(decorator)));
  }

  /**
   * Records a class, its methods and its fields; nested classes are
   * recorded as `Outer.Inner`.
   *
   * @param node - `class_definition` node.
   * @param decorators - Its decorators.
   * @param outer - Qualified name of the enclosing class, if any.
   */
  private addClass(node: Node, decorators: readonly Node[], outer: string | undefined): void {
    const simpleName = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body');
    if (simpleName === undefined || body === null) {
      return;
    }
    const name = outer === undefined ? simpleName : `${outer}.${simpleName}`;
    if (outer === undefined) {
      this.topLevelNames.add(simpleName);
      this.exports.push({ exportedName: simpleName, localName: simpleName });
    }
    const classEnv: Env = new Map();
    for (const decorator of decorators) {
      this.visit(decorator, classEnv, this.moduleUses);
    }
    const bases: PyExpr[] = [];
    const superclasses = node.childForFieldName('superclasses');
    for (const base of superclasses === null ? [] : namedChildren(superclasses)) {
      if (base.type === 'keyword_argument') {
        continue;
      }
      bases.push(
        this.exprOf(
          base.type === 'subscript' ? (base.childForFieldName('value') ?? base) : base,
          classEnv,
        ),
      );
    }
    const fields: Record<string, PyExpr> = {};
    const pyClass: PyClass = {
      name,
      bases,
      fields,
      protocol:
        bases.some((base) => base.t === 'name' && base.name === 'Protocol') ||
        bases.some((base) => base.t === 'attr' && base.name === 'Protocol'),
      line: startLine(node),
    };
    this.classes.push(pyClass);
    const exported = !simpleName.startsWith('_');

    for (const member of namedChildren(body)) {
      const { definition, decorators: memberDecorators } = unwrapDecorated(member);
      if (definition.type === 'function_definition') {
        if (this.isOverload(memberDecorators)) {
          continue;
        }
        if (this.isAccessor(memberDecorators)) {
          this.addAccessor(definition, memberDecorators, name, fields);
          continue;
        }
        this.addFunction(definition, memberDecorators, { name, exported, fields }, new Map());
      } else if (definition.type === 'class_definition') {
        this.addClass(definition, memberDecorators, name);
      } else if (definition.type === 'expression_statement') {
        this.classField(definition, fields, classEnv);
      } else {
        this.visit(definition, classEnv, this.moduleUses);
      }
    }
  }

  /**
   * Walks a property setter or deleter: its uses belong to the property.
   *
   * @param node - `function_definition` node.
   * @param decorators - Its decorators.
   * @param className - Qualified name of the class.
   * @param fields - Fields of the class (filled by `self.x = …`).
   */
  private addAccessor(
    node: Node,
    decorators: readonly Node[],
    className: string,
    fields: Record<string, PyExpr>,
  ): void {
    const name = node.childForFieldName('name')?.text;
    if (name === undefined) {
      return;
    }
    const uses: PyUse[] = [];
    const env: Env = new Map();
    for (const decorator of decorators) {
      this.visit(decorator, env, uses);
    }
    // `@x.setter` reads `x`, which is not a use of the property itself.
    uses.length = 0;
    this.bindParameters(node, env, uses, 'method');
    const body = node.childForFieldName('body');
    if (body !== null) {
      this.walkBlock(body, env, uses, fields);
    }
    const key = `${className}.${name}`;
    this.accessorUses.set(key, [...(this.accessorUses.get(key) ?? []), ...uses]);
  }

  /**
   * Whether a method is a property setter or deleter (`@x.setter`).
   *
   * @param decorators - Its decorators.
   * @returns `true` for accessors other than the getter.
   */
  private isAccessor(decorators: readonly Node[]): boolean {
    return decorators.some((decorator) => /\.(setter|deleter)$/.test(decoratorName(decorator)));
  }

  /**
   * Records a field declared in a class body (`name: T = …` or `name = …`).
   *
   * @param statement - `expression_statement` node.
   * @param fields - Fields of the class (mutated).
   * @param env - Class scope.
   */
  private classField(statement: Node, fields: Record<string, PyExpr>, env: Env): void {
    const assignment = namedChildren(statement)[0];
    const left = assignment?.type === 'assignment' ? assignment.childForFieldName('left') : null;
    if (assignment === undefined || left?.type !== 'identifier') {
      this.visit(statement, env, this.moduleUses);
      return;
    }
    const annotation = assignment.childForFieldName('type');
    const right = assignment.childForFieldName('right');
    if (right !== null) {
      this.visit(right, env, this.moduleUses);
    }
    fields[left.text] =
      annotation !== null
        ? { t: 'ann', text: annotationText(annotation) }
        : right === null
          ? UNKNOWN
          : this.exprOf(right, env);
  }

  /**
   * Records a top-level lambda (`name = lambda …: …`) as a function.
   *
   * @param name - Variable name.
   * @param assignment - `assignment` node.
   * @param lambda - `lambda` node.
   */
  private addLambda(name: string, assignment: Node, lambda: Node): void {
    const uses: PyUse[] = [];
    this.visit(lambda, new Map(), uses);
    this.functions.push({
      name,
      qualifiedName: name,
      functionKind: 'arrow',
      line: startLine(assignment),
      endLine: assignment.endPosition.row + 1,
      exported: !name.startsWith('_'),
      calls: [],
      python: { uses },
    });
  }

  /**
   * Records a function or method with its signature and uses.
   *
   * @param node - `function_definition` node.
   * @param decorators - Its decorators.
   * @param owner - Enclosing class (name, visibility and fields to fill), for methods.
   * @param outerEnv - Variables of the enclosing scope.
   */
  private addFunction(
    node: Node,
    decorators: readonly Node[],
    owner: { name: string; exported: boolean; fields: Record<string, PyExpr> } | undefined,
    outerEnv: Env,
  ): void {
    const name = node.childForFieldName('name')?.text;
    if (name === undefined) {
      return;
    }
    const decoratorNames = decorators.map(decoratorName);
    const isStatic = decoratorNames.includes('staticmethod');
    const isClassMethod = decoratorNames.includes('classmethod');
    const uses: PyUse[] = [];
    const env: Env = new Map(outerEnv);
    for (const decorator of decorators) {
      const expression = namedChildren(decorator)[0];
      if (expression === undefined || BUILTIN_DECORATORS.has(expression.text)) {
        continue;
      }
      // `@timed` calls `timed`; `@retry(2)` calls `retry` (visited), then its result.
      if (expression.type !== 'call') {
        uses.push({ kind: 'call', expr: this.exprOf(expression, env), line: startLine(decorator) });
      }
      this.visit(expression, env, uses);
    }
    this.bindParameters(
      node,
      env,
      uses,
      owner === undefined ? 'function' : isStatic ? 'static' : isClassMethod ? 'class' : 'method',
    );
    const returnType = node.childForFieldName('return_type');
    const body = node.childForFieldName('body');
    if (body !== null) {
      this.walkBlock(body, env, uses, owner?.fields);
    }
    const info: PyFunctionInfo = {
      ...(returnType === null ? {} : { returns: { t: 'ann', text: annotationText(returnType) } }),
      ...(decoratorNames.some((decorator) => PROPERTY_DECORATORS.has(decorator))
        ? { property: true }
        : {}),
      ...(decoratorNames.some((decorator) => /(^|\.)abstractmethod$/.test(decorator)) ||
      isStub(body)
        ? { abstract: true }
        : {}),
      ...(isStatic ? { static: true } : {}),
      uses,
    };
    this.functions.push({
      name,
      qualifiedName: owner === undefined ? name : `${owner.name}.${name}`,
      ...(owner === undefined ? {} : { className: owner.name }),
      functionKind: owner === undefined ? 'function' : 'method',
      line: startLine(node),
      endLine: node.endPosition.row + 1,
      exported: owner === undefined ? !name.startsWith('_') : owner.exported,
      calls: [],
      python: info,
    });
  }

  /**
   * Binds the parameters of a function: annotated ones get their type,
   * `self` / `cls` the enclosing class; defaults and annotations are uses
   * (`Depends(get_service)`).
   *
   * @param node - `function_definition` or `lambda` node.
   * @param env - Variables of the function (mutated).
   * @param uses - Uses of the function (mutated).
   * @param kind - What the first parameter is bound to.
   */
  private bindParameters(
    node: Node,
    env: Env,
    uses: PyUse[],
    kind: 'function' | 'method' | 'static' | 'class',
  ): void {
    const parameters = node.childForFieldName('parameters');
    let first = true;
    for (const parameter of parameters === null ? [] : namedChildren(parameters)) {
      const nameNode = parameterName(parameter);
      const annotation = parameter.childForFieldName('type');
      const value = parameter.childForFieldName('value');
      if (annotation !== null) {
        this.visit(annotation, env, uses);
      }
      if (value !== null) {
        this.visit(value, env, uses);
      }
      if (nameNode === null) {
        continue;
      }
      const isFirst = first;
      first = false;
      if (isFirst && kind === 'method') {
        env.set(nameNode.text, { t: 'self' });
        continue;
      }
      if (isFirst && kind === 'class') {
        env.set(nameNode.text, { t: 'cls' });
        continue;
      }
      const splat = namedChildren(parameter).some((child) => child.type === 'list_splat_pattern');
      if (annotation !== null) {
        const type: PyExpr = { t: 'ann', text: annotationText(annotation) };
        // `*items: T` is a tuple of T.
        env.set(nameNode.text, splat ? { t: 'ann', text: `tuple[${type.text}, ...]` } : type);
      } else {
        // `def f(log=log)`: without annotation, the default value is the best guess.
        env.set(nameNode.text, value === null || splat ? UNKNOWN : this.exprOf(value, env));
      }
    }
  }

  /**
   * Walks the statements of a block in order, so each statement sees the
   * variables assigned before it.
   *
   * @param block - `block` node (or a single statement).
   * @param env - Variables in scope (mutated by assignments).
   * @param uses - Uses of the enclosing function (mutated).
   * @param fields - Fields of the enclosing class, filled by `self.x = …`.
   */
  private walkBlock(block: Node, env: Env, uses: PyUse[], fields?: Record<string, PyExpr>): void {
    for (const statement of block.type === 'block' ? namedChildren(block) : [block]) {
      this.statement(statement, env, uses, fields);
    }
  }

  /**
   * Handles one statement inside a function.
   *
   * @param node - Statement node.
   * @param env - Variables in scope (mutated).
   * @param uses - Uses of the enclosing function (mutated).
   * @param fields - Fields of the enclosing class, filled by `self.x = …`.
   */
  private statement(node: Node, env: Env, uses: PyUse[], fields?: Record<string, PyExpr>): void {
    const { definition, decorators } = unwrapDecorated(node);
    switch (definition.type) {
      case 'import_statement':
        this.imports.push(...collectImportStatement(definition));
        return;
      case 'import_from_statement':
        this.imports.push(...collectImportFrom(definition));
        return;
      case 'function_definition': {
        // A nested function belongs to its parent: its uses are the parent's.
        const nestedEnv: Env = new Map(env);
        for (const decorator of decorators) {
          this.visit(decorator, env, uses);
        }
        // A closure defined in a method with a `self` parameter becomes a method (`cls.x = temp`).
        const inMethod = [...env.values()].some((value) => value.t === 'self' || value.t === 'cls');
        const firstParameter = namedChildren(
          definition.childForFieldName('parameters') ?? definition,
        )[0];
        this.bindParameters(
          definition,
          nestedEnv,
          uses,
          inMethod && firstParameter?.text === 'self' ? 'method' : 'function',
        );
        const body = definition.childForFieldName('body');
        if (body !== null) {
          this.walkBlock(body, nestedEnv, uses);
        }
        const name = definition.childForFieldName('name')?.text;
        if (name !== undefined) {
          env.set(name, UNKNOWN);
        }
        return;
      }
      case 'class_definition':
        this.visit(definition, env, uses);
        return;
      case 'expression_statement':
        for (const expression of namedChildren(definition)) {
          this.expressionStatement(expression, env, uses, fields);
        }
        return;
      case 'for_statement': {
        const iterable = definition.childForFieldName('right');
        if (iterable !== null) {
          this.visit(iterable, env, uses);
          this.bindTarget(
            definition.childForFieldName('left'),
            { t: 'elem', of: this.exprOf(iterable, env) },
            env,
          );
        }
        this.walkChildren(definition, env, uses, fields, ['body', 'alternative']);
        return;
      }
      case 'with_statement':
        for (const clause of namedChildren(definition)) {
          if (clause.type === 'with_clause') {
            for (const item of namedChildren(clause)) {
              this.withItem(item, env, uses);
            }
          }
        }
        this.walkChildren(definition, env, uses, fields, ['body']);
        return;
      default:
        break;
    }
    // Compound statements: visit their expressions, walk their blocks in order.
    for (const child of namedChildren(definition)) {
      if (child.type === 'block') {
        this.walkBlock(child, env, uses, fields);
      } else if (isClause(child)) {
        this.statement(child, env, uses, fields);
      } else {
        this.visit(child, env, uses);
      }
    }
  }

  /**
   * Walks the blocks of some fields of a compound statement.
   *
   * @param node - Compound statement.
   * @param env - Variables in scope.
   * @param uses - Uses (mutated).
   * @param fields - Fields of the enclosing class.
   * @param names - Field names holding blocks or clauses.
   */
  private walkChildren(
    node: Node,
    env: Env,
    uses: PyUse[],
    fields: Record<string, PyExpr> | undefined,
    names: readonly string[],
  ): void {
    for (const name of names) {
      const child = node.childForFieldName(name);
      if (child !== null) {
        if (child.type === 'block') {
          this.walkBlock(child, env, uses, fields);
        } else {
          this.statement(child, env, uses, fields);
        }
      }
    }
  }

  /**
   * Handles one `with` item: `with value as target`.
   *
   * @param item - `with_item` node.
   * @param env - Variables in scope (mutated).
   * @param uses - Uses (mutated).
   */
  private withItem(item: Node, env: Env, uses: PyUse[]): void {
    const value = item.childForFieldName('value') ?? namedChildren(item)[0];
    if (value === undefined) {
      return;
    }
    if (value.type !== 'as_pattern') {
      this.visit(value, env, uses);
      return;
    }
    const [expression] = namedChildren(value);
    const alias = value.childForFieldName('alias');
    if (expression === undefined) {
      return;
    }
    this.visit(expression, env, uses);
    const target = alias === null ? undefined : (namedChildren(alias)[0] ?? alias);
    this.bindTarget(target ?? null, { t: 'enter', of: this.exprOf(expression, env) }, env);
  }

  /**
   * Handles an expression statement: assignments bind variables (and
   * `self.x = …` fields), other expressions are visited.
   *
   * @param node - Expression node.
   * @param env - Variables in scope (mutated).
   * @param uses - Uses (mutated).
   * @param fields - Fields of the enclosing class.
   */
  private expressionStatement(
    node: Node,
    env: Env,
    uses: PyUse[],
    fields?: Record<string, PyExpr>,
  ): void {
    if (node.type !== 'assignment' && node.type !== 'augmented_assignment') {
      this.visit(node, env, uses);
      return;
    }
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const annotation = node.childForFieldName('type');
    if (right !== null) {
      // `a = b = value`: the right side is itself an assignment.
      if (right.type === 'assignment') {
        this.expressionStatement(right, env, uses, fields);
      } else {
        this.visit(right, env, uses);
      }
    }
    if (left === null || node.type === 'augmented_assignment') {
      if (left !== null && left.type !== 'identifier') {
        this.visitTargetObject(left, env, uses);
      }
      return;
    }
    const value: PyExpr =
      annotation !== null
        ? { t: 'ann', text: annotationText(annotation) }
        : right === null
          ? UNKNOWN
          : this.exprOf(
              right.type === 'assignment' ? (right.childForFieldName('right') ?? right) : right,
              env,
            );
    if (left.type === 'attribute') {
      const object = left.childForFieldName('object');
      const attribute = left.childForFieldName('attribute')?.text;
      if (
        fields !== undefined &&
        object !== null &&
        attribute !== undefined &&
        env.get(object.text)?.t === 'self'
      ) {
        // `self.x = …` declares a field; an annotation or the first value wins.
        const current = fields[attribute];
        fields[attribute] =
          annotation !== null || current === undefined || current.t === 'unknown'
            ? value
            : current.t === 'ann'
              ? current
              : anyOf([current, value]);
        return;
      }
      this.visitTargetObject(left, env, uses);
      return;
    }
    this.bindTarget(left, value, env);
  }

  /**
   * Visits the object part of an assignment target (`a.b().c = …` uses `a.b`).
   *
   * @param target - Assignment target.
   * @param env - Variables in scope.
   * @param uses - Uses (mutated).
   */
  private visitTargetObject(target: Node, env: Env, uses: PyUse[]): void {
    const object = target.childForFieldName('object') ?? target.childForFieldName('value');
    if (object !== null) {
      this.visit(object, env, uses);
    }
  }

  /**
   * Binds an assignment target to a value; tuples and other patterns make
   * their names unknown.
   *
   * @param target - Target node, if any.
   * @param value - Value assigned.
   * @param env - Variables in scope (mutated).
   */
  private bindTarget(target: Node | null, value: PyExpr, env: Env): void {
    if (target === null) {
      return;
    }
    if (target.type === 'identifier') {
      env.set(target.text, value);
      return;
    }
    // `obj.x = …` and `items[0] = …` bind no name; only patterns hold names.
    if (!PATTERN_TARGETS.has(target.type)) {
      return;
    }
    for (const child of namedChildren(target)) {
      if (child.type === 'identifier') {
        env.set(child.text, UNKNOWN);
      } else {
        this.bindTarget(child, UNKNOWN, env);
      }
    }
  }

  /**
   * Visits an expression, recording calls, references and attribute reads.
   *
   * @param node - Expression node.
   * @param env - Variables in scope.
   * @param uses - Uses (mutated).
   */
  private visit(node: Node, env: Env, uses: PyUse[]): void {
    switch (node.type) {
      case 'call': {
        const callee = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        if (callee !== null) {
          uses.push({ kind: 'call', expr: this.exprOf(callee, env), line: startLine(node) });
          this.visitCalleeParts(callee, env, uses);
        }
        if (args !== null) {
          this.visitArguments(args, env, uses);
        }
        return;
      }
      case 'attribute': {
        uses.push({ kind: 'read', expr: this.exprOf(node, env), line: startLine(node) });
        const object = node.childForFieldName('object');
        if (object !== null) {
          this.visit(object, env, uses);
        }
        return;
      }
      case 'lambda': {
        const lambdaEnv: Env = new Map(env);
        const parameters = node.childForFieldName('parameters');
        for (const parameter of parameters === null ? [] : namedChildren(parameters)) {
          const name = parameter.type === 'identifier' ? parameter : namedChildren(parameter)[0];
          if (name !== undefined) {
            lambdaEnv.set(name.text, UNKNOWN);
          }
        }
        const body = node.childForFieldName('body');
        if (body !== null) {
          this.visit(body, lambdaEnv, uses);
        }
        return;
      }
      case 'named_expression': {
        const value = node.childForFieldName('value');
        const name = node.childForFieldName('name');
        if (value !== null) {
          this.visit(value, env, uses);
          if (name !== null) {
            env.set(name.text, this.exprOf(value, env));
          }
        }
        return;
      }
      case 'class_definition':
      case 'function_definition':
        // Definitions nested in expressions or functions: their bodies still belong here.
        for (const child of namedChildren(node)) {
          this.visit(child, new Map(env), uses);
        }
        return;
      default:
        break;
    }
    if (COMPREHENSIONS.has(node.type)) {
      this.visitComprehension(node, env, uses);
      return;
    }
    for (const child of namedChildren(node)) {
      if (child.type === 'block') {
        this.walkBlock(child, env, uses);
      } else {
        this.visit(child, env, uses);
      }
    }
  }

  /**
   * Visits a comprehension: its `for` clauses bind variables used by the body.
   *
   * @param node - Comprehension node.
   * @param env - Variables in scope.
   * @param uses - Uses (mutated).
   */
  private visitComprehension(node: Node, env: Env, uses: PyUse[]): void {
    const inner: Env = new Map(env);
    const children = namedChildren(node);
    for (const clause of children) {
      if (clause.type === 'for_in_clause') {
        const iterable = clause.childForFieldName('right');
        if (iterable !== null) {
          this.visit(iterable, inner, uses);
          this.bindTarget(
            clause.childForFieldName('left'),
            { t: 'elem', of: this.exprOf(iterable, inner) },
            inner,
          );
        }
      }
    }
    for (const child of children) {
      if (child.type !== 'for_in_clause') {
        this.visit(child, inner, uses);
      }
    }
  }

  /**
   * Visits what a callee contains besides itself (`a.b()` → reads of `a`,
   * `f(x)()` → the inner call).
   *
   * @param callee - Callee node.
   * @param env - Variables in scope.
   * @param uses - Uses (mutated).
   */
  private visitCalleeParts(callee: Node, env: Env, uses: PyUse[]): void {
    if (callee.type === 'attribute') {
      const object = callee.childForFieldName('object');
      if (object !== null) {
        this.visit(object, env, uses);
      }
    } else if (callee.type !== 'identifier') {
      this.visit(callee, env, uses);
    }
  }

  /**
   * Visits call arguments: a function or method passed as a value is a
   * reference (called later).
   *
   * @param args - `argument_list` node.
   * @param env - Variables in scope.
   * @param uses - Uses (mutated).
   */
  private visitArguments(args: Node, env: Env, uses: PyUse[]): void {
    for (const argument of namedChildren(args)) {
      const value =
        argument.type === 'keyword_argument' ? argument.childForFieldName('value') : argument;
      if (value === null) {
        continue;
      }
      if (value.type === 'identifier' || value.type === 'attribute') {
        uses.push({ kind: 'ref', expr: this.exprOf(value, env), line: startLine(value) });
        if (value.type === 'attribute') {
          const object = value.childForFieldName('object');
          if (object !== null) {
            this.visit(object, env, uses);
          }
        }
        continue;
      }
      this.visit(value, env, uses);
    }
  }

  /**
   * Converts an expression into what the linker can evaluate.
   *
   * @param node - Expression node.
   * @param env - Variables in scope.
   * @returns The expression.
   */
  public exprOf(node: Node, env: Env): PyExpr {
    switch (node.type) {
      case 'identifier':
        return env.get(node.text) ?? { t: 'name', name: node.text };
      case 'attribute': {
        const object = node.childForFieldName('object');
        const attribute = node.childForFieldName('attribute')?.text;
        return object === null || attribute === undefined
          ? UNKNOWN
          : { t: 'attr', of: this.exprOf(object, env), name: attribute };
      }
      case 'call': {
        const callee = node.childForFieldName('function');
        if (callee === null) {
          return UNKNOWN;
        }
        if (callee.type === 'identifier' && callee.text === 'super' && !env.has('super')) {
          return { t: 'super' };
        }
        return { t: 'call', of: this.exprOf(callee, env) };
      }
      case 'await':
      case 'parenthesized_expression': {
        const inner = namedChildren(node)[0];
        return inner === undefined ? UNKNOWN : this.exprOf(inner, env);
      }
      case 'conditional_expression': {
        const [whenTrue, , whenFalse] = namedChildren(node);
        return anyOf(
          [whenTrue, whenFalse]
            .filter((part): part is Node => part !== undefined)
            .map((part) => this.exprOf(part, env)),
        );
      }
      case 'boolean_operator': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        return anyOf(
          [left, right]
            .filter((part): part is Node => part !== null)
            .map((part) => this.exprOf(part, env)),
        );
      }
      case 'list':
      case 'tuple':
      case 'set': {
        // A literal collection: iterating it gives one of its items.
        const element = anyOf(namedChildren(node).map((item) => this.exprOf(item, env)));
        return element.t === 'unknown' ? UNKNOWN : { t: 'items', of: element };
      }
      default:
        return UNKNOWN;
    }
  }
}

/**
 * Name of a parameter (`x`, `x: T`, `x=1`, `*xs: T`, `**kw`).
 *
 * @param parameter - Parameter node.
 * @returns The identifier node, or `null` (separators like `*` and `/`).
 */
function parameterName(parameter: Node): Node | null {
  if (parameter.type === 'identifier') {
    return parameter;
  }
  const named = parameter.childForFieldName('name');
  if (named !== null) {
    return named;
  }
  for (const child of namedChildren(parameter)) {
    if (child.type === 'identifier') {
      return child;
    }
    if (child.type === 'list_splat_pattern' || child.type === 'dictionary_splat_pattern') {
      return namedChildren(child).find((inner) => inner.type === 'identifier') ?? null;
    }
  }
  return null;
}

/**
 * Whether a node is a clause of a compound statement (walked like a statement).
 *
 * @param node - Node.
 * @returns `true` for `elif`, `else`, `except`, `finally` and `case` clauses.
 */
function isClause(node: Node): boolean {
  return node.type.endsWith('_clause');
}

/**
 * Whether a function body is only a declaration (`...`, `pass`, a docstring).
 *
 * @param body - `block` node, if any.
 * @returns `true` for stubs.
 */
function isStub(body: Node | null): boolean {
  if (body === null) {
    return true;
  }
  return namedChildren(body).every((statement) => {
    if (statement.type === 'pass_statement') {
      return true;
    }
    if (statement.type !== 'expression_statement') {
      return false;
    }
    const expression = namedChildren(statement)[0];
    return expression?.type === 'ellipsis' || expression?.type === 'string';
  });
}

/**
 * Parses one Python file.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @param content - File text.
 * @returns Imports (also those under `if TYPE_CHECKING:` and inside
 *   functions), functions (top-level functions, methods including those of
 *   nested classes, and lambdas assigned at the top level; nested functions
 *   belong to the enclosing function), exports and the Python details used
 *   to resolve calls with types. Syntax errors never throw.
 * @throws Error if {@link preparePython} has not completed.
 */
export function parsePython(filePath: RelPath, content: string): ParsedFile {
  if (parser === undefined) {
    throw new Error('The Python grammar is not loaded; call preparePython() first.');
  }
  const tree = parser.parse(content);
  if (tree === null) {
    return { filePath, imports: [], functions: [], exports: [] };
  }
  try {
    const walker = new ModuleWalker();
    walker.walkModule(namedChildren(tree.rootNode));
    const functions = walker.functions.map((fn): ParsedFunction => {
      const extra = walker.accessorUses.get(fn.qualifiedName);
      return extra === undefined || fn.python === undefined
        ? fn
        : { ...fn, python: { ...fn.python, uses: [...fn.python.uses, ...extra] } };
    });
    const python: PyModuleInfo = {
      classes: walker.classes,
      variables: walker.variables,
      uses: walker.moduleUses,
      ...(walker.all === undefined ? {} : { all: walker.all }),
    };
    return {
      filePath,
      imports: walker.imports,
      functions: functions.sort((a, b) => a.line - b.line),
      exports: walker.exports,
      python,
    };
  } finally {
    tree.delete(); // Syntax trees live in WASM memory and must be freed.
  }
}
