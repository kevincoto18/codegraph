/**
 * Resolves Python calls with types: evaluates the expressions recorded by
 * the parser (see `pythonModel.ts`) across modules, classes (with their
 * bases), fields, signatures and annotations, and adds the call edges.
 *
 * @remarks Static and best effort: an expression whose value cannot be
 * known adds no edge, so precision is kept over recall.
 */
import type { GraphEdge, RelPath } from '../../shared';
import { createEdgeId } from '../../shared';
import type { FileIndex, IndexedFunction, WorkspaceIndex } from './linker';
import type { PyClass, PyExpr, PyUse } from './pythonModel';

/** A class, by file and qualified name. */
interface ClassRef {
  readonly file: RelPath;
  readonly name: string;
}

/** What an expression may evaluate to. */
type PyValue =
  | { readonly v: 'module'; readonly file: RelPath }
  | { readonly v: 'class'; readonly cls: ClassRef }
  | { readonly v: 'instance'; readonly cls: ClassRef }
  /** `super()` inside a method of `cls`: the instance seen through the bases. */
  | { readonly v: 'super'; readonly cls: ClassRef }
  | {
      readonly v: 'function';
      readonly fn: IndexedFunction;
      readonly file: RelPath;
      readonly owner?: ClassRef;
    }
  /** A collection whose elements are `of`. */
  | { readonly v: 'items'; readonly of: readonly PyValue[] };

/** Where an expression is evaluated: its module and, in a method, its class. */
interface Context {
  readonly file: RelPath;
  readonly cls?: ClassRef;
}

/** A type parsed from an annotation. */
type TypeTerm =
  | { readonly k: 'name'; readonly path: readonly string[] }
  | { readonly k: 'items'; readonly of: readonly TypeTerm[] }
  | { readonly k: 'class'; readonly of: readonly TypeTerm[] };

/** Lookup tables of one module. */
interface ModuleTables {
  readonly classes: ReadonlyMap<string, PyClass>;
  /** Methods by class, then by name. */
  readonly methods: ReadonlyMap<string, ReadonlyMap<string, IndexedFunction>>;
  /** Top-level functions by name. */
  readonly functions: ReadonlyMap<string, IndexedFunction>;
  /** Files whose names `from m import *` brings in. */
  readonly starFiles: readonly RelPath[];
}

/** Deepest evaluation; deeper expressions are left unknown. */
const MAX_DEPTH = 12;

/** Generic types whose arguments are their elements. */
const COLLECTION_TYPES: ReadonlySet<string> = new Set([
  'list',
  'List',
  'set',
  'Set',
  'frozenset',
  'FrozenSet',
  'tuple',
  'Tuple',
  'Sequence',
  'MutableSequence',
  'Iterable',
  'Iterator',
  'Collection',
  'Generator',
  'AsyncIterator',
  'AsyncIterable',
  'AsyncGenerator',
  'deque',
  'Deque',
  'KeysView',
  'ValuesView',
]);

/** Generic types that stand for one of their arguments. */
const UNION_TYPES: ReadonlySet<string> = new Set(['Optional', 'Union']);

/** Generic types that stand for their first argument. */
const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'Annotated',
  'Final',
  'ClassVar',
  'Required',
  'NotRequired',
  'ReadOnly',
]);

/** Generic types that stand for their last argument (what awaiting gives). */
const AWAITABLE_TYPES: ReadonlySet<string> = new Set(['Awaitable', 'Coroutine']);

/**
 * Splits a type list at top-level separators (outside brackets).
 *
 * @param text - Text to split.
 * @param separator - `,` or `|`.
 * @returns The trimmed parts.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '[' || char === '(') {
      depth += 1;
    } else if (char === ']' || char === ')') {
      depth -= 1;
    } else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/**
 * Parses an annotation into the types it may stand for.
 *
 * @param text - Annotation text (`list[Order] | None`, `"Repo"`, `m.Order`).
 * @returns The types (empty for `None`, `Any`, callables…).
 */
export function parseAnnotation(text: string): TypeTerm[] {
  const clean = text
    .trim()
    .replace(/^(['"])(.*)\1$/s, '$2')
    .trim();
  const union = splitTopLevel(clean, '|');
  if (union.length > 1) {
    return union.flatMap(parseAnnotation);
  }
  const generic = /^([\w.]+)\s*\[(.*)\]$/s.exec(clean);
  if (generic === null) {
    if (!/^[A-Za-z_][\w.]*$/.test(clean) || clean === 'None' || clean === 'Any') {
      return [];
    }
    return [{ k: 'name', path: clean.split('.') }];
  }
  const base = generic[1] ?? '';
  const simple = base.split('.').pop() ?? base;
  const args = splitTopLevel(generic[2] ?? '', ',').filter((arg) => arg !== '...');
  if (UNION_TYPES.has(simple)) {
    return args.flatMap(parseAnnotation);
  }
  if (WRAPPER_TYPES.has(simple)) {
    return parseAnnotation(args[0] ?? '');
  }
  if (AWAITABLE_TYPES.has(simple)) {
    return parseAnnotation(args[args.length - 1] ?? '');
  }
  if (COLLECTION_TYPES.has(simple)) {
    const elements = simple === 'tuple' || simple === 'Tuple' ? args : args.slice(0, 1);
    return [{ k: 'items', of: elements.flatMap(parseAnnotation) }];
  }
  if (simple === 'type' || simple === 'Type') {
    return [{ k: 'class', of: parseAnnotation(args[0] ?? '') }];
  }
  if (simple === 'dict' || simple === 'Dict' || simple === 'Mapping' || simple === 'Callable') {
    return [];
  }
  // A generic class of the project (`Registry[Gateway]`): an instance of it.
  return [{ k: 'name', path: base.split('.') }];
}

/**
 * Key that identifies a value, to remove duplicates.
 *
 * @param value - Value.
 * @returns The key.
 */
function valueKey(value: PyValue): string {
  switch (value.v) {
    case 'module':
      return `m:${value.file}`;
    case 'class':
    case 'instance':
    case 'super':
      return `${value.v}:${value.cls.file}#${value.cls.name}`;
    case 'function':
      return `f:${value.fn.id}`;
    case 'items':
      return `i:${value.of.map(valueKey).join(',')}`;
  }
}

/**
 * Removes duplicate values.
 *
 * @param values - Values.
 * @returns The distinct values.
 */
function unique(values: readonly PyValue[]): PyValue[] {
  return [...new Map(values.map((value) => [valueKey(value), value])).values()];
}

/**
 * Evaluates Python expressions over the workspace. One instance serves the
 * call edges of one file; it records which files it looked into, so the
 * incremental linker knows what to relink when they change.
 */
export class PythonResolver {
  private readonly tables = new Map<RelPath, ModuleTables>();
  private readonly nameCache = new Map<string, PyValue[]>();
  private readonly resultCache = new Map<string, PyValue[]>();
  private readonly fieldCache = new Map<string, PyValue[]>();
  private readonly mroCache = new Map<string, ClassRef[]>();
  /** Lookups in progress, to stop on cycles. */
  private readonly active = new Set<string>();

  /**
   * Creates the resolver.
   *
   * @param workspace - Indexes of every file.
   * @param consulted - Files looked into (filled while resolving).
   */
  public constructor(
    private readonly workspace: WorkspaceIndex,
    public readonly consulted: Set<RelPath> = new Set(),
  ) {}

  /**
   * Adds the call edges of a Python file: from each function, and from the
   * file itself for module-level code.
   *
   * @param fileIndex - Index of the file.
   * @param edges - Edge accumulator keyed by id (mutated in place).
   */
  public addCallEdges(fileIndex: FileIndex, edges: Map<string, GraphEdge>): void {
    const file = fileIndex.parsed.filePath;
    for (const fn of fileIndex.functions) {
      const python = fn.parsed.python;
      if (python === undefined) {
        continue;
      }
      const context: Context =
        fn.parsed.className === undefined
          ? { file }
          : { file, cls: { file, name: fn.parsed.className } };
      this.addUseEdges(fn.id, python.uses, context, edges);
    }
    const moduleUses = fileIndex.parsed.python?.uses ?? [];
    this.addUseEdges(fileIndex.fileId, moduleUses, { file }, edges);
  }

  /**
   * Adds the edges of a list of uses.
   *
   * @param source - Id of the calling function or file.
   * @param uses - Uses to resolve.
   * @param context - Where they appear.
   * @param edges - Edge accumulator (mutated in place).
   */
  private addUseEdges(
    source: string,
    uses: readonly PyUse[],
    context: Context,
    edges: Map<string, GraphEdge>,
  ): void {
    for (const use of uses) {
      for (const target of this.targetsOf(use, context)) {
        if (target === source) {
          continue;
        }
        const id = createEdgeId('call', source, target);
        if (!edges.has(id)) {
          edges.set(id, { id, kind: 'call', source, target, line: use.line });
        }
      }
    }
  }

  /**
   * Functions a use runs.
   *
   * @param use - The use.
   * @param context - Where it appears.
   * @returns Function ids.
   */
  private targetsOf(use: PyUse, context: Context): string[] {
    if (use.kind === 'read') {
      // Reading an attribute runs code only when it is a property.
      if (use.expr.t !== 'attr') {
        return [];
      }
      const name = use.expr.name;
      return this.evaluate(use.expr.of, context, 0).flatMap((owner) => {
        const member = this.findMember(owner, name);
        return member?.kind === 'method' && member.fn.parsed.python?.property === true
          ? [member.fn.id]
          : [];
      });
    }
    const values = this.evaluate(use.expr, context, 0);
    const targets: string[] = [];
    for (const value of values) {
      if (value.v === 'function') {
        targets.push(value.fn.id);
      } else if (use.kind === 'call' && value.v === 'class') {
        const init = this.findMember({ v: 'instance', cls: value.cls }, '__init__');
        if (init?.kind === 'method') {
          targets.push(init.fn.id);
        }
      } else if (use.kind === 'call' && value.v === 'instance') {
        const call = this.findMember(value, '__call__');
        if (call?.kind === 'method') {
          targets.push(call.fn.id);
        }
      }
    }
    return [...new Set(targets)];
  }

  /**
   * Evaluates an expression.
   *
   * @param expr - Expression.
   * @param context - Where it appears.
   * @param depth - Current nesting, to stop on deep or cyclic expressions.
   * @returns What it may evaluate to.
   */
  private evaluate(expr: PyExpr, context: Context, depth: number): PyValue[] {
    if (depth > MAX_DEPTH) {
      return [];
    }
    const next = depth + 1;
    switch (expr.t) {
      case 'name':
        return this.lookupName(context.file, expr.name, next);
      case 'self':
        return context.cls === undefined ? [] : [{ v: 'instance', cls: context.cls }];
      case 'cls':
        return context.cls === undefined ? [] : [{ v: 'class', cls: context.cls }];
      case 'super':
        return context.cls === undefined ? [] : [{ v: 'super', cls: context.cls }];
      case 'attr':
        return unique(
          this.evaluate(expr.of, context, next).flatMap((value) =>
            this.memberValues(value, expr.name, next),
          ),
        );
      case 'call':
        // `super().__new__(cls)` and `object.__new__(cls)` create an instance of the class.
        if (expr.of.t === 'attr' && expr.of.name === '__new__' && context.cls !== undefined) {
          return [{ v: 'instance', cls: context.cls }];
        }
        return unique(
          this.evaluate(expr.of, context, next).flatMap((value) => this.resultOf(value, next)),
        );
      case 'ann':
        return this.annotationValues(expr.text, context, next);
      case 'elem':
        return unique(
          this.evaluate(expr.of, context, next).flatMap((value) => this.elementsOf(value, next)),
        );
      case 'enter':
        return unique(
          this.evaluate(expr.of, context, next).flatMap((value) => this.enterValue(value, next)),
        );
      case 'items':
        return [{ v: 'items', of: this.evaluate(expr.of, context, next) }];
      case 'any':
        return unique(expr.of.flatMap((part) => this.evaluate(part, context, next)));
      case 'unknown':
        return [];
    }
  }

  /**
   * Values of an annotation.
   *
   * @param text - Annotation text.
   * @param context - Where it is written.
   * @param depth - Current nesting.
   * @returns Instances of the annotated classes (collections of them, or the classes for `type[X]`).
   */
  private annotationValues(text: string, context: Context, depth: number): PyValue[] {
    if (text === 'Self' || text === 'typing.Self') {
      return context.cls === undefined ? [] : [{ v: 'instance', cls: context.cls }];
    }
    return unique(parseAnnotation(text).flatMap((term) => this.termValues(term, context, depth)));
  }

  /**
   * Values of a parsed annotation type.
   *
   * @param term - Type.
   * @param context - Where it is written.
   * @param depth - Current nesting.
   * @returns The values.
   */
  private termValues(term: TypeTerm, context: Context, depth: number): PyValue[] {
    switch (term.k) {
      case 'items':
        return [
          { v: 'items', of: term.of.flatMap((inner) => this.termValues(inner, context, depth)) },
        ];
      case 'class':
        return term.of
          .flatMap((inner) => this.termValues(inner, context, depth))
          .flatMap((value): PyValue[] =>
            value.v === 'instance' ? [{ v: 'class', cls: value.cls }] : [],
          );
      case 'name': {
        const [first, ...rest] = term.path;
        if (first === undefined) {
          return [];
        }
        let values = this.lookupName(context.file, first, depth);
        for (const part of rest) {
          values = values.flatMap((value) => this.memberValues(value, part, depth));
        }
        return values.flatMap((value): PyValue[] =>
          value.v === 'class' ? [{ v: 'instance', cls: value.cls }] : [],
        );
      }
    }
  }

  /**
   * Resolves a name of a module's scope: its functions, classes and
   * variables, then its imports (following re-exports) and `import *`.
   *
   * @param file - Module.
   * @param name - Name.
   * @param depth - Current nesting.
   * @returns What the name may be.
   */
  private lookupName(file: RelPath, name: string, depth: number): PyValue[] {
    const key = `${file}\u0000${name}`;
    const cached = this.nameCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.active.has(key) || depth > MAX_DEPTH) {
      return [];
    }
    this.active.add(key);
    try {
      const values = this.computeName(file, name, depth);
      this.nameCache.set(key, values);
      return values;
    } finally {
      this.active.delete(key);
    }
  }

  /**
   * Uncached {@link lookupName}.
   *
   * @param file - Module.
   * @param name - Name.
   * @param depth - Current nesting.
   * @returns What the name may be.
   */
  private computeName(file: RelPath, name: string, depth: number): PyValue[] {
    const index = this.indexOf(file);
    const tables = this.tablesOf(file);
    if (index === undefined || tables === undefined) {
      return [];
    }
    const fn = tables.functions.get(name);
    if (fn !== undefined) {
      return [{ v: 'function', fn, file }];
    }
    if (tables.classes.has(name)) {
      return [{ v: 'class', cls: { file, name } }];
    }
    const variable = index.parsed.python?.variables[name];
    if (variable !== undefined) {
      return this.evaluate(variable, { file }, depth);
    }
    const binding = index.bindings.get(name);
    if (binding !== undefined) {
      if (binding.binding.kind === 'namespace') {
        return [{ v: 'module', file: binding.targetFile }];
      }
      return this.lookupName(binding.targetFile, binding.binding.importedName, depth + 1);
    }
    for (const starFile of tables.starFiles) {
      const starAll = this.indexOf(starFile)?.parsed.python?.all;
      if (starAll === undefined ? name.startsWith('_') : !starAll.includes(name)) {
        continue;
      }
      const values = this.lookupName(starFile, name, depth + 1);
      if (values.length > 0) {
        return values;
      }
    }
    return [];
  }

  /**
   * Values of `value.name`.
   *
   * @param value - Object.
   * @param name - Attribute name.
   * @param depth - Current nesting.
   * @returns What the attribute may be.
   */
  private memberValues(value: PyValue, name: string, depth: number): PyValue[] {
    if (value.v === 'module') {
      const values = this.lookupName(value.file, name, depth);
      return values.length > 0 ? values : this.submodule(value.file, name);
    }
    const member = this.findMember(value, name);
    if (member === undefined) {
      return [];
    }
    switch (member.kind) {
      case 'method': {
        const fnValue: PyValue = {
          v: 'function',
          fn: member.fn,
          file: member.owner.file,
          owner: member.owner,
        };
        // Reading a property gives what it returns.
        return member.fn.parsed.python?.property === true && value.v !== 'class'
          ? this.resultOf(fnValue, depth)
          : [fnValue];
      }
      case 'class':
        return [{ v: 'class', cls: member.cls }];
      case 'field':
        return this.fieldValues(
          member.owner,
          name,
          value.v === 'class' ? member.owner : (selfOf(value) ?? member.owner),
          depth,
        );
    }
  }

  /**
   * A submodule of a package (`import pkg` then `pkg.mod`).
   *
   * @param file - Package file (`pkg/__init__.py`).
   * @param name - Submodule name.
   * @returns The module, if it exists.
   */
  private submodule(file: RelPath, name: string): PyValue[] {
    if (!file.endsWith('__init__.py')) {
      return [];
    }
    const folder = file.slice(0, -'__init__.py'.length);
    for (const candidate of [`${folder}${name}.py`, `${folder}${name}/__init__.py`]) {
      if (this.workspace.has(candidate)) {
        this.consulted.add(candidate);
        return [{ v: 'module', file: candidate }];
      }
    }
    return [];
  }

  /**
   * Finds an attribute of a class, an instance or `super()` along the
   * method resolution order.
   *
   * @param value - Class, instance or `super()`.
   * @param name - Attribute name.
   * @returns The method, nested class or field, if any.
   */
  private findMember(
    value: PyValue,
    name: string,
  ):
    | { readonly kind: 'method'; readonly fn: IndexedFunction; readonly owner: ClassRef }
    | { readonly kind: 'class'; readonly cls: ClassRef }
    | { readonly kind: 'field'; readonly owner: ClassRef }
    | undefined {
    if (value.v !== 'class' && value.v !== 'instance' && value.v !== 'super') {
      return undefined;
    }
    const order = this.mro(value.cls);
    for (const cls of value.v === 'super' ? order.slice(1) : order) {
      const tables = this.tablesOf(cls.file);
      const method = tables?.methods.get(cls.name)?.get(name);
      if (method !== undefined) {
        return { kind: 'method', fn: method, owner: cls };
      }
      const nested = `${cls.name}.${name}`;
      if (tables?.classes.has(nested) === true) {
        return { kind: 'class', cls: { file: cls.file, name: nested } };
      }
      if (tables?.classes.get(cls.name)?.fields[name] !== undefined) {
        return { kind: 'field', owner: cls };
      }
    }
    return undefined;
  }

  /**
   * Values of a field.
   *
   * @param owner - Class that declares it.
   * @param name - Field name.
   * @param self - Class `self` stands for (the instance's own class).
   * @param depth - Current nesting.
   * @returns What the field may hold.
   */
  private fieldValues(owner: ClassRef, name: string, self: ClassRef, depth: number): PyValue[] {
    const key = `${owner.file}#${owner.name}.${name}@${self.file}#${self.name}`;
    const cached = this.fieldCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.active.has(key)) {
      return [];
    }
    const expr = this.tablesOf(owner.file)?.classes.get(owner.name)?.fields[name];
    if (expr === undefined) {
      return [];
    }
    this.active.add(key);
    try {
      const values = this.evaluate(expr, { file: owner.file, cls: self }, depth);
      this.fieldCache.set(key, values);
      return values;
    } finally {
      this.active.delete(key);
    }
  }

  /**
   * What calling a value returns.
   *
   * @param value - Called value.
   * @param depth - Current nesting.
   * @returns Instances for classes, the declared return type for functions.
   */
  private resultOf(value: PyValue, depth: number): PyValue[] {
    switch (value.v) {
      case 'class':
        return [{ v: 'instance', cls: value.cls }];
      case 'function': {
        const key = value.fn.id;
        const cached = this.resultCache.get(key);
        if (cached !== undefined) {
          return cached;
        }
        const returns = value.fn.parsed.python?.returns;
        if (returns === undefined || this.active.has(key)) {
          return [];
        }
        this.active.add(key);
        try {
          const context: Context =
            value.owner === undefined
              ? { file: value.file }
              : { file: value.file, cls: value.owner };
          const values = this.evaluate(returns, context, depth);
          this.resultCache.set(key, values);
          return values;
        } finally {
          this.active.delete(key);
        }
      }
      case 'instance': {
        const call = this.findMember(value, '__call__');
        return call?.kind === 'method'
          ? this.resultOf(
              { v: 'function', fn: call.fn, file: call.owner.file, owner: value.cls },
              depth,
            )
          : [];
      }
      default:
        return [];
    }
  }

  /**
   * What iterating a value gives.
   *
   * @param value - Iterated value.
   * @param depth - Current nesting.
   * @returns The element values.
   */
  private elementsOf(value: PyValue, depth: number): PyValue[] {
    if (value.v === 'items') {
      return [...value.of];
    }
    if (value.v !== 'instance') {
      return [];
    }
    const iterator = this.findMember(value, '__iter__');
    if (iterator?.kind !== 'method') {
      return [];
    }
    return this.resultOf(
      { v: 'function', fn: iterator.fn, file: iterator.owner.file, owner: value.cls },
      depth,
    ).flatMap((result) => (result.v === 'items' ? [...result.of] : []));
  }

  /**
   * Value bound by `with value as x`: what `__enter__` returns, or the value itself.
   *
   * @param value - Context manager.
   * @param depth - Current nesting.
   * @returns The bound values.
   */
  private enterValue(value: PyValue, depth: number): PyValue[] {
    if (value.v !== 'instance') {
      return [value];
    }
    const enter = this.findMember(value, '__enter__');
    if (enter?.kind !== 'method' || enter.fn.parsed.python?.returns === undefined) {
      return [value];
    }
    return this.resultOf(
      { v: 'function', fn: enter.fn, file: enter.owner.file, owner: value.cls },
      depth,
    );
  }

  /**
   * Method resolution order of a class (depth first, left to right, without repeats).
   *
   * @param cls - Class.
   * @returns The class and its project bases.
   */
  private mro(cls: ClassRef): ClassRef[] {
    const key = `${cls.file}#${cls.name}`;
    const cached = this.mroCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const order: ClassRef[] = [];
    const seen = new Set<string>();
    /**
     * Adds a class and its bases.
     *
     * @param current - Class to add.
     * @param level - Inheritance depth.
     */
    const visit = (current: ClassRef, level: number): void => {
      const currentKey = `${current.file}#${current.name}`;
      if (seen.has(currentKey) || level > MAX_DEPTH) {
        return;
      }
      seen.add(currentKey);
      order.push(current);
      const pyClass = this.tablesOf(current.file)?.classes.get(current.name);
      for (const base of pyClass?.bases ?? []) {
        for (const value of this.evaluate(base, { file: current.file }, 0)) {
          if (value.v === 'class') {
            visit(value.cls, level + 1);
          }
        }
      }
    };
    visit(cls, 0);
    this.mroCache.set(key, order);
    return order;
  }

  /**
   * Index of a file, recording the lookup.
   *
   * @param file - Path.
   * @returns The index, if the file is in the workspace.
   */
  private indexOf(file: RelPath): FileIndex | undefined {
    this.consulted.add(file);
    return this.workspace.get(file);
  }

  /**
   * Lookup tables of a Python module, built once.
   *
   * @param file - Path.
   * @returns The tables, or `undefined` for files that are not Python modules.
   */
  private tablesOf(file: RelPath): ModuleTables | undefined {
    const cached = this.tables.get(file);
    if (cached !== undefined) {
      this.consulted.add(file);
      return cached;
    }
    const index = this.indexOf(file);
    const python = index?.parsed.python;
    if (index === undefined || python === undefined) {
      return undefined;
    }
    const methods = new Map<string, Map<string, IndexedFunction>>();
    const functions = new Map<string, IndexedFunction>();
    for (const fn of index.functions) {
      const className = fn.parsed.className;
      if (className === undefined) {
        if (!functions.has(fn.parsed.name)) {
          functions.set(fn.parsed.name, fn);
        }
        continue;
      }
      const byName = methods.get(className) ?? new Map<string, IndexedFunction>();
      if (!byName.has(fn.parsed.name)) {
        byName.set(fn.parsed.name, fn);
      }
      methods.set(className, byName);
    }
    const tables: ModuleTables = {
      classes: new Map(python.classes.map((pyClass) => [pyClass.name, pyClass])),
      methods,
      functions,
      starFiles: index.starImports,
    };
    this.tables.set(file, tables);
    return tables;
  }
}

/**
 * Class `self` stands for when reading a field of a value.
 *
 * @param value - Instance or `super()`.
 * @returns Its class.
 */
function selfOf(value: PyValue): ClassRef | undefined {
  return value.v === 'instance' || value.v === 'super' ? value.cls : undefined;
}
