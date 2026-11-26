# Python showcase

A small but realistic order-processing app (`shop/`) with hand-written fakes
(`tests/`), used to measure how well CodeGraph maps Python code. It runs:
`python -m shop order ada book:2:10` (Python 3.10+).

`expected.json` lists every function node, import and call the graph should
have. Measure the current analyzer against it with:

```sh
just eval-python
# or: node scripts/run.mjs scripts/eval-sample.ts samples/python-showcase
```

The report gives precision and recall for functions, imports and calls,
recall per call category, and every missing or unexpected connection.

## What it covers

| Area            | Syntax                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imports         | `import a.b as c`, relative `from . import x` / `from ..pkg import y`, re-exports in `__init__.py`, `from m import *` with `__all__`, imports inside functions, `if TYPE_CHECKING:`, `try`/`except ImportError` |
| Classes         | inheritance, mixins, `super()`, ABC + `@abstractmethod`, `Protocol`, `@dataclass`, `Enum`, `NamedTuple`, `Generic[T]`, `__slots__`, nested classes, `@staticmethod`, `@classmethod`, `@property`, `@overload`   |
| Calls by type   | `self.repo.save()` (attribute set in `__init__`), annotated parameters, `x = Foo(); x.bar()`, return types, loop variables, `with X() as x:`, chained attributes                                                |
| Indirect calls  | `Class()` → `__init__`, Protocol / ABC → implementations, decorators (also with arguments), callbacks (`map`, `sorted(key=)`, `partial`), lambdas, closures, `Depends(...)`, `app(...)` → `__call__`            |
| Other           | `async`/`await`, generators, comprehensions, `match`/`case`, walrus `:=`, module-level code (`if __name__ == "__main__":`), definitions inside `if`/`else`                                                      |
| Precision traps | `shop/domain/collections.py` vs the stdlib `collections`; `_json.dumps` vs `dumps`; two `FakeGateway` classes; `report` vs `Application.report`; `describe` vs `Order.Meta.describe`; many `send` methods       |

## Rules of the ground truth

- **Function nodes**: top-level functions, methods (`Class.method`, nested
  classes as `Outer.Inner.method`) and lambdas assigned at the top level.
  Nested functions are folded into the function that defines them. Overloads
  of a method are one node.
- **Imports**: one edge to the module actually imported. `from pkg import name`
  points to `pkg/__init__.py`, or to `pkg/name.py` when `name` is a submodule.
  Imports under `TYPE_CHECKING` and inside functions count. Standard library
  modules never resolve to project files.
- **Calls** go from the enclosing function, or from the file for module-level
  code. They include references that call the function later (callbacks,
  decorators, `Depends(...)`). `Class()` points to `Class.__init__` when the
  class defines one; reading a `@property` points to its getter.
- **Polymorphism**: a call through a `Protocol` or ABC method points to that
  method and to every implementation (ABC: subclasses; Protocol: classes that
  define the method). A call on a concrete class points only to that class's
  method (or the inherited one).
- **Not expected**: builtins and libraries, and implicit dunder calls (`with`
  → `__enter__`, `+` → `__add__`, `for` → `__iter__`).
