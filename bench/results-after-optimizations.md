# CodeGraph — performance after optimizations (2026-11-21)

Results after P3 (UI), P4 (analysis) and P5 (folder view), compared with
[`results-before-optimizations.md`](results-before-optimizations.md). Same
synthetic projects (`scripts/lib/generateProject.ts`, seed 42), same
environment: Linux x64, 2 CPU, 7 GB RAM, Node 22.23, headless Chrome without GPU.
Commit: P5 (`1158862`).

## Targets

| Metric | Before | After | Target | |
|---|---:|---:|---:|:-:|
| First paint, L | timeout (>120 s) | **260 ms** (folder view) · 13.4 s (flat) | < 2 s | ✅ |
| Save → patch, L (p95) | 662 ms | **2.3 ms** (+300 ms editor debounce) | < 150 ms | ✅ |
| Burst of 200 saves, L | 107 s | **114 ms** (1 batch) | < 5 s | ✅ |
| XL opens and is navigable | no | **646 ms** first paint + 1.43 s first level | < 3 s | ✅ |

## Host analysis (`npm run stress:full`)

| | S before | S after | M before | M after | L before | L after | XL before | XL after |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Parse (sum) | 401 ms | 273 ms | 897 ms | 413 ms | 1.86 s | 870 ms | 6.64 s | 3.52 s |
| Link | 46 ms | 47 ms | 101 ms | 119 ms | 320 ms | 358 ms | 1.37 s | 1.74 s |
| **Cold scan** | 499 ms | **363 ms** | 1.23 s | **677 ms** | 2.65 s | **1.62 s** | 9.55 s | **6.55 s** |
| Rescan, same session | 245 ms | 80 ms | 814 ms | 210 ms | 2.28 s | 596 ms | 9.41 s | 2.64 s |
| Warm start, new session (persisted cache) | — | 73 ms | — | 235 ms | — | 983 ms | — | 3.97 s |
| `graph/init` size | 4.5 MB | 308 KB | 19.1 MB | 1.3 MB | 47.3 MB | 3.3 MB | 194.7 MB | 14.0 MB |
| `graph/init` serialize | 13 ms | 1.8 ms | 67 ms | 7.3 ms | 165 ms | 16 ms | 836 ms | 70 ms |
| Single save p50 / p95 | 44 / 63 ms | 0.8 / 2.0 ms | 183 / 269 ms | 0.7 / 4.3 ms | 511 / 662 ms | 0.9 / 2.3 ms | 2.44 / 2.99 s | 1.1 / 2.3 ms |
| Burst of 200 saves | 7.85 s | 73 ms | 39.70 s | 82 ms | 106.78 s | 114 ms | 503.04 s | 186 ms |
| Rename hub export | 39 ms | 3.2 ms | 232 ms | 9.4 ms | 480 ms | 19 ms | 3.11 s | 111 ms |
| Delete folder (250 files) | 8.22 s | 10 ms | 48.61 s | 20 ms | 131.70 s | 25 ms | 657.84 s | 36 ms |
| Heap after scan | 84 MB | 35 MB | 111 MB | 75 MB | 164 MB | 150 MB | 438 MB | 529 MB |
| Heap growth after 3 rescans | 0.3 MB | 0.1 MB | 0.0 MB | 0.1 MB | 0.2 MB | 0.1 MB | 0.1 MB | 0.0 MB |

Warm start breakdown (cache load / list / stat / link): L 211 ms / 77 ms /
44 ms / 625 ms · XL 1.69 s / 276 ms / 169 ms / 1.77 s.

Notes:

- Saves and deletions are now measured as VS Code produces them: the burst
  and the folder deletion are fired at once and coalesced into **one batch**.
  "Single save" is a save applied alone, without the editor's 300 ms debounce.
- Link is ~20 % slower on a full build (the incremental linker also records
  which files depend on which), and XL keeps ~90 MB more heap for those indexes.
  This is the price of near-zero cost per save.

## UI (`npm run stress:ui`)

**Folder view** (`codegraph.folderView: auto`, default — M, L and XL open by folders):

| | M (2k) | L (5k) | XL (20k) |
|---|---:|---:|---:|
| First paint | 141 ms | 260 ms | 646 ms |
| Expand level (first) | 60 ms | 174 ms | 1.43 s |
| Live patch → painted | 70 ms | 114 ms | 469 ms |
| Search keystroke (p50, incl. 150 ms debounce) | 183 ms | 183 ms | 206 ms |
| Idle / pan / zoom FPS | 60 / 60 / 61 | 60 / 60 / 61 | — |
| Expand all | 5.60 s | 13.10 s | tab crashes (235k nodes) |
| Pan FPS (expanded) | 45 | 36 | — |
| Collapse all | 553 ms | 1.32 s | — |
| Re-layout | 32 ms | 41 ms | — |
| webview `layout.full` (p50) | 15 ms | 29 ms | — |

**Flat view** (`codegraph.folderView: never`, comparable to the baseline):

| | S before | S after | M before | M after | L before | L after |
|---|---:|---:|---:|---:|---:|---:|
| First paint (collapsed) | 4.05 s | 614 ms | timeout | 2.44 s | timeout | 13.36 s |
| Live patch → painted | 131 ms | 96 ms | — | 349 ms | — | 805 ms |
| Search keystroke (p50) | 310 ms | 223 ms | — | 472 ms | — | 818 ms |
| Pan / zoom FPS (collapsed) | 7 / 5 | 53 / 14 | — | 21 / 11 | — | 5 / 4 |
| Expand all | 8.87 s | 2.32 s | — | 9.47 s | — | 25.38 s |
| Pan FPS (expanded) | 6 | 54 | — | 31 | — | 18 |
| Collapse all | 3.55 s | 790 ms | — | 3.92 s | — | 13.91 s |
| Re-layout | 3.45 s | 396 ms | — | 3.64 s | — | 13.28 s |
| webview `layout.full` (p50) | 3.00 s | 15 ms | — | 75 ms | — | 163 ms |

Notes:

- In the flat view the layout itself is fast (163 ms at L); the remaining
  time is React Flow drawing every file and edge (L: 5,000 files and ~30,000
  edges on screen). That is what the folder view avoids.
- The flat "idle FPS" of the run (M 4, L 1) was measured while the cleared
  search was still re-rendering; a separate profile of M after 4 s shows
  60 FPS with the main thread idle.

## What is left

| Finding | Impact | Possible fix |
|---|---|---|
| **Expand all** on XL renders 235k nodes and crashes the tab | High (XL only) | Ask for confirmation or cap it above N nodes |
| Flat view above ~2,000 files draws tens of thousands of edges | Medium (only with `folderView: never`) | Hide edges below the low-detail zoom, or recommend the folder view |
| Warm start XL 4 s: cache deserialize 1.7 s + full link 1.8 s | Medium | Persist the linked graph too, or link in a worker |
| Cold scan XL 6.5 s, parse 3.5 s on one thread | Medium | Parse in worker threads (postponed from P4) |
| Opening/closing a container re-runs the full layout | Low (≤ 41 ms at L by folders) | Re-layout only the changed level |
