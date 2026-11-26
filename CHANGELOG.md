# Changelog

All notable changes to CodeGraph Map are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-11-25

### Changed

- **Much more precise Python graphs.** Calls are resolved with types across
  files: annotated parameters and return types, attributes set in `__init__`,
  local and loop variables, `with … as`, inheritance and `super()`,
  `Class()` → `__init__`, properties, decorators, callbacks (`map`, `key=`,
  `partial`), `Depends(...)` and `obj()` → `__call__`. Calls to a `Protocol`
  or abstract method also reach their implementations. Module-level code
  (`if __name__ == "__main__":`) calls from its file. On a reference sample
  (`samples/python-showcase`) the share of calls found goes from 30 % to 99 %,
  with no wrong connection; on the Python standard library, 70 % more calls.
- **Python imports**: imports under `if TYPE_CHECKING:`, inside functions and
  in `try`/`if` blocks are found; `from pkg import module` depends on the
  module only, not on the package; standard library modules (`collections`,
  `subprocess`…) never point to a project file with the same name; re-exports
  and `import *` with `__all__` are followed.
- Python functions defined in `if`/`else` branches and `@overload` stubs are
  one node; methods of nested classes are named `Outer.Inner.method`; property
  setters belong to their property.

## [0.2.0] - 2026-11-25

### Added

- **Review changes (PR review mode)**: command **CodeGraph: Review Changes**
  (also in the Source Control title bar) and a new **Changes** panel. Compares
  the working tree with a base branch picked from the list of branches (or
  detected: `main`, `master`, `develop` or `codegraph.review.baseBranch`), the
  last commit or the commit before it,
  through VS Code's Git extension. Changed functions and files are red, what
  calls or imports them orange (1–3 levels), the rest is dimmed; the list puts
  the riskiest changes first and **Copy summary** copies a Markdown table for
  the pull request. Refreshes as files change.
- **CodeGraph side view** in the Explorer: a small graph that follows the
  active editor. **Files** shows which files use the current one and which it
  uses (with its functions, the one under the cursor highlighted);
  **Functions** shows the callers and callees of the function under the
  cursor, with its signature and doc. Click a node to open it; ⤢ opens the full
  graph focused there. The analysis is shared with the graph panel.
- **Touchpad navigation**: two fingers pan the graph and pinching zooms; a mouse
  wheel still zooms. New setting `codegraph.scrollBehavior` (`auto`, `pan`,
  `zoom`).
- **Keyboard navigation**: arrows pan (faster with Shift), `+` / `-` zoom, `0`
  fits the graph; hold **Space** and drag to pan even over nodes; Shift + wheel
  pans sideways.
- **Multi-root workspaces are easier to read**: each workspace folder is its
  own top-level node (never merged with a sub-folder) with its color, icon and
  languages; everything inside takes its color; the legend groups by workspace
  folder; **Filters → Workspace folders** hides a whole project; tooltips show
  `project › path`.

- **Path between two nodes**: right-click → _Find path from here…_, then pick
  the destination; the shortest chain of calls (or imports between files) is
  highlighted, opened and framed, with its steps in a bar.
- **Hover cards for functions**: signature, first paragraph of the doc comment
  or docstring, and location, read on demand from the source.
- **Unused code**: Filters → _Mark unused code_ tags functions never called
  and files nothing uses, with a list to jump to each (likely entry points
  left out).
- **Export**: everything, what is on screen or chosen files and folders, as
  PNG, SVG or a Mermaid diagram (save or copy).

### Changed

- **Clicking a file opens or closes its function list** instead of opening the
  code. Open the code with Ctrl/Cmd + click, the file's open button (↗) or
  right-click → _Go to code_. Clicking a function still opens it.

## [0.1.0] - 2026-11-24

First public release.

### Added

- Interactive graph of **files, functions, imports and calls**, built by static
  analysis (no language server, no AI).
- Languages: **TypeScript / JavaScript**, **Python**, **Java**, **C#** and **Go**.
  Java, C# and Go calls such as `repo.save()` are resolved by type.
- **Live updates**: saves, external edits, created and deleted files update the
  graph incrementally; a persistent cache makes reopening instant.
- **Folder view** for large projects, collapse and expand per file or folder,
  merged `×n` edges.
- **Fuzzy search** over files and functions, with keyboard navigation.
- **Focus mode**: show a node and its neighbors (1–3 hops, uses / used by), from
  a double-click or the context menu.
- **Show Connections** from the Explorer or the editor, opening the graph beside
  the code.
- **Filters**: hide tests, only exported functions, hidden folders and exclude
  patterns, saved per workspace.
- **Follow the editor**: the graph highlights and centers the code under the
  cursor.
- **Multi-root workspaces**: every folder in one graph.
- The panel **reopens after a window reload** with the same view.
- Respects `files.exclude` and `.gitignore`.

[Unreleased]: https://github.com/kevincoto18/codegraph/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/kevincoto18/codegraph/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kevincoto18/codegraph/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kevincoto18/codegraph/releases/tag/v0.1.0
