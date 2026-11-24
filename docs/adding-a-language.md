# Adding a language to CodeGraph

CodeGraph analyzes every language through one contract. Everything after
parsing — linking, incremental updates, caches, worker threads, the webview,
search and folders — only sees a language-neutral model, so a new language
never touches those layers.

```
                  ┌───────────────────────────────┐
 file.ext ──────▶ │ LanguageAnalyzer (per language)│──▶ ParsedFile (neutral)
                  │  • extensions, version         │        │
                  │  • parse()                     │        ▼
                  │  • listImportCandidates()      │   linker → graph → webview
                  └───────────────────────────────┘
```

## The contract

Defined in [`src/extension/analyzer/language.ts`](../src/extension/analyzer/language.ts):

| Member                                  | Purpose                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`                     | Identity of the language (`python`, `Python`)                                                                                    |
| `extensions`                            | File extensions it handles (`['.py']`); two languages cannot share one                                                           |
| `version`                               | Version of the parser output; bump it when results change so persisted caches are discarded                                      |
| `isExcluded(path)` _(optional)_         | Skip files with a supported extension but nothing to analyze (`.d.ts`)                                                           |
| `listImportCandidates(from, specifier)` | Workspace paths an import may refer to, in priority order (empty for external packages)                                          |
| `parse(path, content)`                  | Imports, functions, calls and exports as a [`ParsedFile`](../src/extension/analyzer/types.ts); must never throw on syntax errors |

The split between `LanguageDefinition` (no parser) and `LanguageAnalyzer`
(definition + `parse`) matters: definitions are loaded when the extension
activates (file filters, import resolution), parsers only in the analyzer
bundle and the worker threads.

### Mapping a language to the neutral model

| Neutral concept                              | TypeScript                   | Python                       | Go                            | Java / C#                       |
| -------------------------------------------- | ---------------------------- | ---------------------------- | ----------------------------- | ------------------------------- |
| Import (`specifier`)                         | `'./utils'`                  | `app.models` / `.models`     | `"example.com/app/db"`        | `com.app.db.Repo` / `App.Db`    |
| Binding `named`                              | `import { a }`               | `from m import a`            | —                             | `import com.app.Repo`           |
| Binding `namespace`                          | `import * as m`              | `import m`                   | `import "pkg"` (package name) | static imports                  |
| Function                                     | functions, arrows, methods   | `def`, methods               | `func`, methods               | methods                         |
| Call `identifier` / `member` / `this-member` | `f()` / `m.f()` / `this.f()` | `f()` / `m.f()` / `self.f()` | `f()` / `pkg.F()` / `r.f()`   | `f()` / `Repo.f()` / `this.f()` |
| Export                                       | `export`                     | every top-level name         | capitalized names             | `public`                        |

## Steps

1. **Write the analyzer** in `src/extension/analyzer/<language>Language.ts`
   (definition) and its parser.
2. **Register it**: add the definition to `LANGUAGES` in
   [`languages.ts`](../src/extension/analyzer/languages.ts) and its parser to
   `PARSERS` in [`analyzers.ts`](../src/extension/analyzer/analyzers.ts).
   File filters, globs and the cache key update automatically.
3. **Test it** like the toy `dummy` language in
   [`language.test.ts`](../src/extension/analyzer/language.test.ts): parse a
   few files, link them, and check the nodes and edges. Add a small sample
   project under `samples/` with an end-to-end test.

## Two ways to parse

|              | Tree-sitter (recommended default)                                                             | VS Code language features / LSP                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| How          | A grammar compiled to WASM plus a query file (`.scm`) that marks imports, functions and calls | Ask the user's installed language extension for symbols (`vscode.executeDocumentSymbolProvider`) and calls (call hierarchy) |
| Speed        | Very fast; runs in the parser workers                                                         | Slow on large projects: one request per file, some servers take seconds                                                     |
| Dependencies | None for the user (ships with CodeGraph)                                                      | The language extension must be installed and configured                                                                     |
| Precision    | Syntactic, like the current TypeScript parser                                                 | Can be semantic (types, `obj.method()`)                                                                                     |
| Coverage     | Any language with a grammar (hundreds)                                                        | Any language with an extension                                                                                              |

**How Tree-sitter languages are built** (Python is the reference):

- [`treeSitter.ts`](../src/extension/analyzer/treeSitter.ts) loads the WASM
  engine and grammars once, from `dist/grammars` (copied by `esbuild.mjs` from
  `@vscode/tree-sitter-wasm`, the builds VS Code uses) or from `node_modules`
  when running from sources.
- The analyzer's `prepare()` loads its grammar. The registry only prepares the
  languages present in the workspace, so a TypeScript project never loads
  Tree-sitter; the parser workers prepare themselves the same way.
- Each language has its own **extractor** that walks the top level of the
  syntax tree (imports, functions, classes) and uses a **query** run inside
  the WASM engine (`(call) @call`) to collect calls, assigning each call to
  the function whose range contains it. This is simpler and more precise than
  expressing everything as `.scm` queries (qualified names, nesting).
- Syntax trees live in WASM memory: always `tree.delete()` after extracting.

To add a Tree-sitter language: add its `.wasm` to `GRAMMAR_FILES` in
`esbuild.mjs`, write `<language>Language.ts` (definition + import resolution)
and `<language>Parser.ts` (prepare + extractor), and register both.

TypeScript/JavaScript keep the TypeScript Compiler API, which understands
them better (CommonJS, re-exports, `import x = require()`). LSP can later
complement any language for semantic call resolution.

**Performance note:** Tree-sitter in WASM parses ~0.6 ms per 50-line Python
file (2,000 files: ~1.3 s parse, ~2.2 s parse + extraction, 3 s full scan);
large scans use the worker threads.

## Path-based and name-based languages

Languages resolve imports in one of two ways, chosen by the parser output:

|               | Path-based (TypeScript, Python)                                 | Name-based (Java, C#, Go)                                                                                                                          |
| ------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import means  | A file found from the specifier's path (`listImportCandidates`) | A type, a namespace or a package folder (`ParsedImport.target`: `type`, `namespace`, `package`)                                                    |
| `ParsedFile`  | `imports`, `functions`, `exports`                               | Also `namespace` (package, namespace or Go folder) and `types` (bases, field types)                                                                |
| Who sees whom | Only what is imported                                           | Same namespace/package without import; C# also parent namespaces (`namespacesSeeParents`); Go imports matched to a folder (`resolvePackage`)       |
| Calls         | `f()`, `m.f()`, `this.f()` with import bindings                 | Also by type: `ParsedCall.receiverType` (inferred by the parser), `receiverField` (`this.repo.save()`), `call:pkg.New` (result type of a function) |

Name-based resolution lives in [`symbols.ts`](../src/extension/analyzer/symbols.ts)
(a workspace table of namespaces and types, updated incrementally) and
[`scope.ts`](../src/extension/analyzer/scope.ts) (what a file can see and how
its calls resolve, following base types). The incremental linker watches the
namespaces each file looks into, so adding a class to a package re-links the
files that use that package. Import edges of `namespace`/`package` imports are
only drawn to the files that are actually used.

**Parsers of name-based languages** share
[`treeSitterDrafts.ts`](../src/extension/analyzer/treeSitterDrafts.ts): the top
level (types, members) is walked in JavaScript, then one query collects
parameters, local declarations and calls inside bodies; each capture is
assigned to its enclosing member, which keeps a map of variable types used to
type the following calls.

## What stays language-specific

- **Import resolution** (`listImportCandidates`): every ecosystem has its own
  rules (relative paths, Python packages and `__init__.py`, Go modules from
  `go.mod`, Java/C# packages mapped to folders).
- **Call semantics** the linker applies today come from JavaScript (e.g.
  calling a CommonJS module imported with `require`). A new language should
  express its constructs with the existing binding and call kinds; if one
  does not fit, extend `types.ts` and the linker together, with tests for
  every language.

## Proposed rollout

| Stage        | Languages                                           |
| ------------ | --------------------------------------------------- |
| Done         | TypeScript, JavaScript, Python, Java, C#, Go        |
| Second batch | PHP, Rust, Kotlin, Ruby                             |
| Later        | C / C++ (`#include` resolution, headers and macros) |
