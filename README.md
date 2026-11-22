# CodeGraph

> VS Code extension (proof of concept) that statically analyzes a TypeScript /
> JavaScript project and renders an interactive, live-updating graph of its
> **files**, **functions**, **imports** and **calls**.

- Files are containers; their functions are nested nodes.
- Dashed edges are imports between files; solid edges are calls between functions.
- Click any node to jump to the exact line in the editor.
- Save a file and only that file (and the files linked to it) is re-analyzed; the graph updates in place.

---

## Features

| Feature           | Details                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Static analysis   | TypeScript Compiler API (`ts.createSourceFile`), no type checker, no LLM                                                                                                             |
| Languages         | `.ts`, `.tsx`, `.js`, `.jsx` (`.d.ts` skipped); `node_modules`, `dist`, `build`, `.git`, `files.exclude` and `.gitignore`d files ignored                                             |
| Imports           | ES default / named (aliased) / namespace / side-effect, re-exports, `require`, `import x = require()`                                                                                |
| Functions         | Declarations, arrow & function expressions assigned to variables, class methods, constructors, arrow class properties, anonymous default exports, CommonJS exported functions        |
| Calls             | `foo()`, `ns.foo()`, `this.foo()`, `Class.staticMethod()` — local or imported (ES and CommonJS)                                                                                      |
| Navigation        | Click a file or function to open it at its line, in a column next to the graph                                                                                                       |
| Large projects    | Auto-collapse above 400 functions, linear layered layout (tall ranks wrapped into sub-columns), level of detail when zoomed out, auto-hidden minimap, only visible elements rendered |
| Folder view       | Large projects open as nested folders (compact chains like `src/extension`); edges between folders are merged into `×n` edges                                                        |
| Collapse / expand | Per file or all at once; calls of collapsed files are merged into `×n` edges                                                                                                         |
| Search            | By file path or function name; matches highlighted, Enter zooms to them, Escape clears                                                                                               |
| Live updates      | Saves, external edits, created/deleted files and folders → debounced → queued changes batched → incremental relink → one patch                                                       |
| Layout stability  | Live patches keep file positions (including manual drags), collapsed files, search and viewport                                                                                      |
| Cache             | Per-file SHA-256 hash, persisted between sessions; files with unchanged mtime/size are not even read                                                                                 |

## Requirements

- **VS Code** 1.95 or newer
- **Node.js** 20+ (22 recommended) and npm

## Getting started

```bash
npm install
npm run build
```

Then press **F5** in VS Code and pick a launch configuration:

| Configuration                     | Opens                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------- |
| **Run CodeGraph**                 | The Extension Development Host with the last folder you used there               |
| **Run CodeGraph on demo project** | The Extension Development Host on [`samples/demo-project`](samples/demo-project) |

Both configurations build first and start the host with `--disable-extensions`,
so only CodeGraph is loaded. In the new window run **`CodeGraph: Open Graph`**
from the Command Palette (`Ctrl+Shift+P`).

## Usage

| Action                       | How                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Open the graph               | `CodeGraph: Open Graph`                                                                                                   |
| Go to code                   | Click a function or a file header                                                                                         |
| Collapse / expand a file     | `▸` / `▾` button in the file header                                                                                       |
| Open / close a folder        | Click the folder (or its `▸` / `▾` button)                                                                                |
| Go one level deeper          | **Expand level** (collapsed folders first, then files)                                                                    |
| Collapse / expand everything | **Collapse all** / **Expand all**                                                                                         |
| Search                       | Type in the search box · **Enter** opens the folders/files hiding the matches and zooms to them · **Escape** clears       |
| Choose connections           | **Show: Imports · Calls · Internal calls** (calls inside a file are hidden by default); a legend explains the line styles |
| Tidy the layout              | **Re-layout** (recomputes positions, e.g. after many live changes)                                                        |
| Full rescan                  | **Refresh**                                                                                                               |
| Zoom / pan / move files      | Mouse wheel · drag the background · drag a file header                                                                    |

Logs are written to the **CodeGraph** output channel (`Ctrl+Shift+U`).

### Settings

| Setting                       | Values                      | Default  | Effect                                                                        |
| ----------------------------- | --------------------------- | -------- | ----------------------------------------------------------------------------- |
| `codegraph.collapseByDefault` | `always` · `auto` · `never` | `always` | Whether files start collapsed (`auto`: above 400 functions)                   |
| `codegraph.folderView`        | `auto` · `always` · `never` | `auto`   | Group files into nested folders that open on demand (`auto`: above 300 files) |

## Architecture

```mermaid
flowchart LR
  subgraph Host["Extension host (Node)"]
    direction TB
    CMD["CodeGraph: Open Graph"] --> CTRL[CodeGraphController]
    CTRL --> SVC[GraphService]
    SYNC[WorkspaceSync<br/>save · watcher · debounce] --> SVC
    SVC --> CACHE[AnalysisCache<br/>SHA-256]
    CACHE --> PARSER[parser<br/>TS Compiler API]
    CACHE --> STORE[(cache file<br/>v8 serialized)]
    SVC --> LINKER[incremental linker<br/>+ resolver → GraphPatch]
    CTRL --> PANEL[CodeGraphPanel<br/>CSP + nonce]
  end
  subgraph Webview["Webview (React)"]
    direction TB
    CHANNEL[useGraphChannel<br/>reducer + applyPatch] --> VIEW[GraphView<br/>collapse · search · layout]
    VIEW --> FLOW[React Flow + layered layout]
  end
  PANEL <-- "postMessage<br/>ready · graph/init (compact, chunked) · graph/patch · status · navigate · refresh" --> CHANNEL
```

### Project layout

```
src/
├─ shared/        Environment-agnostic contract: graph model, ids, message protocol + guards
├─ extension/     VS Code host
│  ├─ analyzer/   Pure analysis: language registry, TS/JS language (parser, resolver), linker, incremental linker, diff
│  ├─ cache.ts, cacheStore.ts, exclusions.ts, graphService.ts, changeScheduler.ts   Pure orchestration (unit-tested)
│  ├─ analysis.ts Entry of the analyzer bundle (`dist/analysis.js`), loaded on first use
│  └─ controller.ts, panel.ts, workspaceSync.ts, workspaceReader.ts, navigation.ts   VS Code adapters
└─ webview/       React app: channel, flow conversion, collapse, search, layout, patches, components
samples/demo-project/   Mixed TS/JS project covering every supported construct
```

Pure modules never import `vscode`; VS Code access goes through thin adapters
(`WorkspaceReader` port, `WorkspaceSync`, `CodeGraphPanel`), which keeps the
analysis and the webview logic unit-testable.

### Data model

Defined in [`src/shared/types.ts`](src/shared/types.ts): `GraphNode`
(`file` | `function`, with `filePath` and 1-based `line`), `GraphEdge`
(`import` | `call`), `GraphSnapshot` and `GraphPatch`. Ids are stable and never
contain line numbers (`src/a.ts`, `src/a.ts#Class.method`), so editing code
above a function does not recreate its node. Full graphs travel to the webview
in a compact wire format ([`src/shared/wire.ts`](src/shared/wire.ts)): file
paths are sent once, ids are derived and edges are node indexes, split into
chunks.

### Performance design

- **Instant activation**: the analyzer and the TypeScript compiler it embeds
  live in a separate bundle loaded the first time a graph is opened.
- **Warm starts**: the parse cache is saved in the workspace storage (V8
  serialization) and reused when files keep their modification time and size.
- **Cheap saves**: queued changes are applied as one batch, and only the
  changed files, the files whose imports may now resolve differently and the
  importers of changed files are re-linked.
- **Instant reopen**: the last graph is saved too and shown immediately; the
  rescan then sends only what changed.
- **Parallel parsing**: large scans (3,000+ files) parse on worker threads
  (`dist/parseWorker.js`) as well as the main thread.
- **Large canvases**: the canvas mounts at its final zoom, skips edges while
  zoomed out on very large graphs, and **Expand all** stops at 15,000 nodes.

## Scripts

| Script                                      | Purpose                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `npm run build`                             | Bundle the extension and analyzer (esbuild) and the webview (Vite) |
| `npm run watch:extension` / `watch:webview` | Rebuild on change                                                  |
| `npm test` / `npm run test:watch`           | Unit and integration tests (Vitest)                                |
| `npm run typecheck`                         | Type-check host and webview projects                               |
| `npm run lint`                              | ESLint (strict type-checked, TSDoc required), zero warnings        |
| `npm run format` / `format:check`           | Prettier                                                           |

## Testing

`npm test` runs ~300 tests: parser, resolver, linker (incremental linking is
checked against a full relink on random workspaces), diff, cache and its
persistence, exclusions, wire format, graph service (in-memory workspace), change scheduler, webview HTML/CSP, and every
pure webview module (flow conversion, collapse, search, layout, patches).
`src/extension/demoProject.test.ts` analyzes `samples/demo-project` end to end
and asserts the complete expected graph.

## Languages

TypeScript and JavaScript are supported today. Every language plugs in
through the same `LanguageAnalyzer` contract; see
[docs/adding-a-language.md](docs/adding-a-language.md) for the design and the
rollout plan (Python, Java, C#, Go next).

## Known limitations

- Calls through **barrel re-exports** (`export … from`) are not followed (the file edge is shown).
- **Path aliases** (`tsconfig` `paths`, e.g. `@/utils`) are not resolved; only relative imports are.
- Calls on arbitrary objects (`obj.method()`, `a.b.c()`, `new X().m()`) are not resolved.
- Nested functions are not nodes; their calls are attributed to the enclosing function.
- Only the **first workspace folder** is analyzed; up to 5000 files.
- Changes to `files.exclude` or `.gitignore` apply on the next **Refresh**; a nested `.gitignore` cannot re-include files ignored by a parent one.
- Collapse/expand and **Re-layout** recompute positions, discarding manual drags.
- TypeScript is pinned to **6.0.x**: TypeScript 7 (native port) does not expose the classic JS Compiler API.

## Troubleshooting

| Symptom                                                          | Fix                                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Extension Development Host window closes right after opening | Another extension (e.g. one that patches the workbench) interfered. The launch configurations already pass `--disable-extensions`; also close any stale development host window |
| The graph is empty                                               | Make sure a folder with `.ts/.js` files is open in the development host, then press **Refresh**                                                                                 |
| Slow `npm install` on OneDrive                                   | Exclude `node_modules` from OneDrive sync                                                                                                                                       |

## Roadmap

- **ELK layout** (`elkjs`): native compound graphs and orthogonal edge routing
- Optional **type checker** mode for precise `obj.method()` resolution
- Follow **re-exports** and resolve **`paths` aliases**
- **Multi-root** workspaces
- Execution **simulation** on top of the current model (`nodes`, `edges`, `filePath`, `line`)

## License

UNLICENSED — private proof of concept.
