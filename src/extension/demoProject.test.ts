/**
 * Integration test: analyzes `samples/demo-project` end to end (parser,
 * resolver and linker) and checks the complete expected graph, so any
 * regression in the analysis pipeline is caught.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import { toPosixPath } from '../shared';
import { isAnalyzableFile } from './analyzer/config';
import { linkGraph } from './analyzer/linker';
import { parseSource } from './analyzer/parser';

/** Absolute path of the demo project. */
const DEMO_ROOT = fileURLToPath(new URL('../../samples/demo-project', import.meta.url));

/**
 * Parses and links every analyzable file of the demo project.
 *
 * @returns The demo graph.
 */
function analyzeDemoProject(): GraphSnapshot {
  const filePaths = readdirSync(DEMO_ROOT, { recursive: true, encoding: 'utf8' })
    .map(toPosixPath)
    .filter(isAnalyzableFile);
  const parsed = filePaths.map((filePath) =>
    parseSource(filePath, readFileSync(join(DEMO_ROOT, filePath), 'utf8')),
  );
  return linkGraph(parsed, 1);
}

/**
 * Lists `source -> target` pairs of every edge of a kind.
 *
 * @param snapshot - Graph snapshot.
 * @param kind - Edge kind to keep.
 * @returns Sorted pairs.
 */
function edgePairs(snapshot: GraphSnapshot, kind: 'import' | 'call'): string[] {
  return snapshot.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.source} -> ${edge.target}`)
    .sort();
}

describe('demo project', () => {
  const graph = analyzeDemoProject();

  it('finds every file with its functions', () => {
    const files = graph.nodes
      .filter((node) => node.kind === 'file')
      .map((node) => `${node.id} (${String(node.functionIds.length)})`);
    expect(files).toEqual([
      'legacy/config.js (1)',
      'legacy/defaults.js (1)',
      'legacy/server.js (1)',
      'src/app.ts (2)',
      'src/components/UserCard.tsx (2)',
      'src/data/repository.ts (2)',
      'src/index.ts (1)',
      'src/services/userService.ts (3)',
      'src/utils/date.ts (2)',
      'src/utils/index.ts (0)',
      'src/utils/logger.ts (3)',
      'src/utils/validation.ts (1)',
    ]);
  });

  it('links files through relative imports, re-exports and require (packages ignored)', () => {
    expect(edgePairs(graph, 'import')).toEqual([
      'legacy/config.js -> legacy/defaults.js',
      'legacy/server.js -> legacy/config.js',
      'src/app.ts -> src/services/userService.ts',
      'src/app.ts -> src/utils/date.ts',
      'src/app.ts -> src/utils/logger.ts',
      'src/components/UserCard.tsx -> src/utils/date.ts',
      'src/index.ts -> legacy/server.js',
      'src/index.ts -> src/app.ts',
      'src/services/userService.ts -> src/data/repository.ts',
      'src/services/userService.ts -> src/utils/index.ts',
      'src/services/userService.ts -> src/utils/logger.ts',
      'src/utils/index.ts -> src/utils/logger.ts',
      'src/utils/index.ts -> src/utils/validation.ts',
    ]);
  });

  it('resolves every supported call shape', () => {
    expect(edgePairs(graph, 'call')).toEqual([
      'legacy/config.js#getConfig -> legacy/defaults.js#loadDefaults',
      'legacy/server.js#start -> legacy/config.js#getConfig',
      'src/app.ts#createApp -> src/app.ts#startServer',
      'src/app.ts#createApp -> src/utils/logger.ts#info',
      'src/app.ts#startServer -> src/services/userService.ts#UserService.bootstrap',
      'src/app.ts#startServer -> src/utils/date.ts#formatDate',
      'src/app.ts#startServer -> src/utils/logger.ts#info',
      'src/components/UserCard.tsx#UserCard -> src/components/UserCard.tsx#track',
      'src/components/UserCard.tsx#UserCard -> src/utils/date.ts#formatDate',
      'src/data/repository.ts#save -> src/data/repository.ts#connect',
      'src/index.ts#main -> legacy/server.js#start',
      'src/index.ts#main -> src/app.ts#createApp',
      'src/services/userService.ts#UserService.notify -> src/utils/logger.ts#info',
      'src/services/userService.ts#UserService.register -> src/data/repository.ts#save',
      'src/services/userService.ts#UserService.register -> src/services/userService.ts#UserService.notify',
      'src/services/userService.ts#UserService.register -> src/utils/logger.ts#warn',
      'src/utils/date.ts#formatDate -> src/utils/date.ts#pad',
      'src/utils/logger.ts#info -> src/utils/logger.ts#write',
      'src/utils/logger.ts#warn -> src/utils/logger.ts#write',
    ]);
  });

  it('documents the barrel limitation: calls through re-exports stay unresolved', () => {
    expect(edgePairs(graph, 'call')).not.toContain(
      'src/services/userService.ts#UserService.register -> src/utils/validation.ts#validateEmail',
    );
  });
});
