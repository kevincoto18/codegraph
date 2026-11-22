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

**Plan:** a single generic `TreeSitterAnalyzer` configured per language
(grammar + `queries.scm` + a small import resolver), so most languages need no
new parsing code. TypeScript/JavaScript keep the TypeScript Compiler API,
which understands them better (CommonJS, re-exports, `import x = require()`).
LSP can later complement any language for semantic call resolution.

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
| Today        | TypeScript, JavaScript                              |
| First batch  | Python, Java, C#, Go                                |
| Second batch | PHP, Rust, Kotlin, Ruby                             |
| Later        | C / C++ (`#include` resolution, headers and macros) |
