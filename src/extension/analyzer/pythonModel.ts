/**
 * Python-specific analysis data: what the parser records about classes,
 * signatures and every use of a name, for the linker to evaluate with types
 * (see `pythonResolver.ts`).
 *
 * @remarks Plain JSON-serializable data: it is stored in the parse cache.
 */

/**
 * An expression whose value the linker evaluates. Local variables are
 * replaced by what was assigned to them, so the linker only sees module
 * names, `self`, attribute accesses, calls and annotations.
 */
export type PyExpr =
  /** A name of the module scope: class, function, variable or import. */
  | { readonly t: 'name'; readonly name: string }
  /** `of.name` */
  | { readonly t: 'attr'; readonly of: PyExpr; readonly name: string }
  /** The result of calling `of`. */
  | { readonly t: 'call'; readonly of: PyExpr }
  /** The instance a method runs on (`self`). */
  | { readonly t: 'self' }
  /** The class a classmethod runs on (`cls`). */
  | { readonly t: 'cls' }
  /** `super()`: the instance seen through the base classes. */
  | { readonly t: 'super' }
  /** A type annotation, as written (`list[Order] | None`). */
  | { readonly t: 'ann'; readonly text: string }
  /** An element obtained by iterating `of` (`for x in of`). */
  | { readonly t: 'elem'; readonly of: PyExpr }
  /** The value bound by `with of as x`. */
  | { readonly t: 'enter'; readonly of: PyExpr }
  /** A literal collection (`[a, b]`): iterating it gives one of `of`. */
  | { readonly t: 'items'; readonly of: PyExpr }
  /** Any of several values (a variable assigned in several places). */
  | { readonly t: 'any'; readonly of: readonly PyExpr[] }
  /** A value that cannot be known (lambda parameters, subscripts…). */
  | { readonly t: 'unknown' };

/**
 * How a name is used:
 * - `call`: `expr` is called (`expr(...)`, also as a decorator);
 * - `ref`: `expr` is passed as a value and called later (callbacks, `partial`);
 * - `read`: `expr` is an attribute read, which runs code when it is a property.
 */
export type PyUseKind = 'call' | 'ref' | 'read';

/** A use of a name inside a function or at the module level. */
export interface PyUse {
  readonly kind: PyUseKind;
  readonly expr: PyExpr;
  /** 1-based line. */
  readonly line: number;
}

/** Python details of a function or method. */
export interface PyFunctionInfo {
  /** Declared return type. */
  readonly returns?: PyExpr;
  /** Read as an attribute (`@property`, `@cached_property`). */
  readonly property?: boolean;
  /** Declared without a body (`...`, `pass`, docstring) or `@abstractmethod`. */
  readonly abstract?: boolean;
  /** `@staticmethod`. */
  readonly static?: boolean;
  /** Names used by the body, decorators, defaults and annotations. */
  readonly uses: readonly PyUse[];
}

/** A class of a module. */
export interface PyClass {
  /** Name including enclosing classes (`Order.Meta`). */
  readonly name: string;
  /** Base classes, as written. */
  readonly bases: readonly PyExpr[];
  /** Attributes with their value or annotation, from the class body and `self.x = …`. */
  readonly fields: Readonly<Record<string, PyExpr>>;
  /** Whether the class derives from `typing.Protocol`. */
  readonly protocol: boolean;
  /** 1-based line. */
  readonly line: number;
}

/** Python details of a module. */
export interface PyModuleInfo {
  readonly classes: readonly PyClass[];
  /** Module-level variables with their value or annotation. */
  readonly variables: Readonly<Record<string, PyExpr>>;
  /** Uses in module-level code (outside functions). */
  readonly uses: readonly PyUse[];
  /** Names listed in `__all__`, when the module defines it. */
  readonly all?: readonly string[];
}
