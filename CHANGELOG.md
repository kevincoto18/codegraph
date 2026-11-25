# Changelog

All notable changes to CodeGraph Map are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

[0.1.0]: https://github.com/kevincoto18/codegraph/releases/tag/v0.1.0
