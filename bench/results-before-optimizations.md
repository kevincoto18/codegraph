# CodeGraph — performance before optimizations (2026-11-21)

Reference results to compare against once the optimization phases (P3–P5)
are finished. Same synthetic projects (`scripts/lib/generateProject.ts`,
seed 42) and the same scripts (`npm run stress`, `npm run stress:ui`).

Environment: Linux x64, 2 CPU, 7 GB RAM, Node 22.23, headless Chrome without GPU.
Commit: P2 (measurement and stress tooling).

## Host analysis (`npm run stress`, `stress:full`)

|                                   |         S (500) |             M (2k) |             L (5k) |             XL (20k) |
| --------------------------------- | --------------: | -----------------: | -----------------: | -------------------: |
| Functions                         |           5,395 |             22,008 |             53,527 |              215,116 |
| Nodes / edges                     |  5,895 / 11,802 |    24,008 / 48,341 |   58,527 / 117,919 |    235,116 / 473,346 |
| List files                        |          7.6 ms |              31 ms |              96 ms |               325 ms |
| Read files                        |           35 ms |             168 ms |             327 ms |               1.03 s |
| Hash (sum)                        |          6.8 ms |              24 ms |              36 ms |               128 ms |
| Parse (sum)                       |          401 ms |             897 ms |             1.86 s |               6.64 s |
| Link                              |           46 ms |             101 ms |             320 ms |               1.37 s |
| **Cold scan total**               |      **499 ms** |         **1.23 s** |         **2.65 s** |           **9.55 s** |
| Repeated scan (p50)               |          245 ms |             814 ms |             2.28 s |               9.41 s |
| `graph/init` size                 |          4.5 MB |            19.1 MB |            47.3 MB |             194.7 MB |
| `graph/init` serialize            |           13 ms |              67 ms |             165 ms |               836 ms |
| Patch size (p50 / max)            |        1 / 3 KB |           1 / 3 KB |           1 / 3 KB |             1 / 3 KB |
| Burst of 200 saves — total        |          7.85 s |            39.70 s |           106.78 s |             503.04 s |
| Per save p50 / p95 / max          | 44 / 63 / 83 ms | 183 / 269 / 339 ms | 511 / 662 / 818 ms | 2.44 / 2.99 / 3.19 s |
| Rename hub export                 |           39 ms |             232 ms |             480 ms |               3.11 s |
| Delete folder (250 files) — total |          8.22 s |            48.61 s |           131.70 s |             657.84 s |
| Delete folder — per file p50      |           30 ms |             185 ms |             503 ms |               2.56 s |
| Heap after scan                   |           84 MB |             111 MB |             164 MB |               438 MB |
| RSS after scan                    |          277 MB |             575 MB |             739 MB |               702 MB |
| Heap growth after 3 rescans       |          0.3 MB |             0.0 MB |             0.2 MB |               0.1 MB |

## UI (`npm run stress:ui`)

|                                    | S (500) |           M (2k) |           L (5k) |
| ---------------------------------- | ------: | ---------------: | ---------------: |
| First paint (collapsed)            |  4.05 s | timeout (>120 s) | timeout (>120 s) |
| Live patch → painted               |  131 ms |                — |                — |
| Search keystroke (p50)             |  310 ms |                — |                — |
| Idle FPS                           |      50 |                — |                — |
| Pan / zoom FPS (collapsed)         |   7 / 5 |                — |                — |
| Expand all                         |  8.87 s |                — |                — |
| Pan FPS (expanded)                 |       6 |                — |                — |
| Collapse all                       |  3.55 s |                — |                — |
| Re-layout                          |  3.45 s |                — |                — |
| JS heap                            |  517 MB |                — |                — |
| webview `layout.full` (p50)        |  3.00 s |                — |                — |
| webview `layout.incremental` (p50) |   11 ms |                — |                — |

## Isolated measurements

**dagre layout** (collapsed files, Node):

| Files | File pairs |                                                                   Time |
| ----- | ---------: | ---------------------------------------------------------------------: |
| 500   |      1,480 |    8.4 s (network-simplex) · 5.2 s (tight-tree) · 8.1 s (longest-path) |
| 1,000 |      2,995 | 41.6 s (network-simplex) · 17.6 s (tight-tree) · 16.8 s (longest-path) |

**Prototype linear layered layout** (longest-path ranks + 2 barycenter sweeps):

| Files  | File pairs |   Time |
| ------ | ---------: | -----: |
| 500    |      1,480 |  21 ms |
| 1,000  |      2,995 |  42 ms |
| 2,000  |      6,125 |  60 ms |
| 5,000  |     15,042 | 155 ms |
| 20,000 |     60,458 | 772 ms |

**Parser** (2,000 synthetic files, 3.7 MB):

| Variant                                             |     Time |
| --------------------------------------------------- | -------: |
| `parseSource` (TS, parent pointers, + walk)         | 1,935 ms |
| `ts.createSourceFile`, parents = true (parse only)  | 1,261 ms |
| `ts.createSourceFile`, parents = false (parse only) |   895 ms |
| `oxc-parser` `parseSync` (parse + JS AST)           |   665 ms |

## Targets for the optimization phases

| Metric                    |  Before |                   Target |
| ------------------------- | ------: | -----------------------: |
| First paint, L collapsed  | timeout |                    < 2 s |
| Save → patch, L (p95)     |  662 ms |                 < 150 ms |
| Burst of 200 saves, L     |   107 s |                    < 5 s |
| XL opens and is navigable |      no | yes (folder view, < 3 s) |
