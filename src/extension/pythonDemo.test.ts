/**
 * Integration test: analyzes `samples/python-demo` through the graph service
 * (Tree-sitter grammar loading, parser, module resolution and linker) and
 * checks the complete expected graph.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { GraphSnapshot, RelPath } from '../shared';
import { toPosixPath } from '../shared';
import { GraphService } from './graphService';

/** Absolute path of the Python demo project. */
const DEMO_ROOT = fileURLToPath(new URL('../../samples/python-demo', import.meta.url));

/** Logger that ignores everything. */
const silent = {
  /** Ignores the message. */
  info: (): void => undefined,
  /** Ignores the message. */
  warn: (): void => undefined,
  /** Ignores the message. */
  error: (): void => undefined,
};

/**
 * Analyzes the demo project with the real service.
 *
 * @returns The demo graph.
 */
async function analyzeDemo(): Promise<GraphSnapshot> {
  const service = new GraphService(
    {
      listFiles: (): Promise<RelPath[]> =>
        Promise.resolve(
          readdirSync(DEMO_ROOT, { recursive: true, encoding: 'utf8' }).map(toPosixPath),
        ),
      readFile: (filePath): Promise<string> =>
        Promise.resolve(readFileSync(join(DEMO_ROOT, filePath), 'utf8')),
    },
    silent,
  );
  return service.initialize();
}

describe('python demo project', async () => {
  const graph = await analyzeDemo();

  it('finds every file with its functions', () => {
    expect(
      graph.nodes
        .filter((node) => node.kind === 'file')
        .map((node) => `${node.id} (${String(node.functionIds.length)})`),
    ).toEqual([
      'app/__init__.py (0)',
      'app/config.py (2)',
      'app/main.py (1)',
      'app/services/__init__.py (0)',
      'app/services/user_service.py (3)',
      'app/utils.py (3)',
      'scripts/run.py (1)',
    ]);
  });

  it('resolves imports: relative, absolute, packages and from-imports', () => {
    expect(
      graph.edges
        .filter((edge) => edge.kind === 'import')
        .map((edge) => `${edge.source} -> ${edge.target}`)
        .sort(),
    ).toEqual([
      'app/__init__.py -> app/services/user_service.py',
      'app/main.py -> app/__init__.py',
      'app/main.py -> app/config.py',
      'app/main.py -> app/services/user_service.py',
      'app/main.py -> app/utils.py',
      'app/services/user_service.py -> app/__init__.py',
      'app/services/user_service.py -> app/config.py',
      'app/services/user_service.py -> app/utils.py',
      'scripts/run.py -> app/main.py',
    ]);
  });

  it('resolves calls: local, imported, module members, static and self methods', () => {
    expect(
      graph.edges
        .filter((edge) => edge.kind === 'call')
        .map((edge) => `${edge.source} -> ${edge.target}`)
        .sort(),
    ).toEqual([
      'app/config.py#load -> app/config.py#_read',
      'app/main.py#main -> app/config.py#load',
      'app/main.py#main -> app/services/user_service.py#UserService.create',
      'app/main.py#main -> app/utils.py#normalize',
      'app/main.py#main -> app/utils.py#slugify',
      'app/services/user_service.py#UserService._save -> app/config.py#load',
      'app/services/user_service.py#UserService._save -> app/services/user_service.py#UserService.validate',
      'app/services/user_service.py#UserService.create -> app/utils.py#slugify',
      'app/utils.py#normalize -> app/utils.py#slugify',
      'app/utils.py#slugify -> app/utils.py#_clean',
      'scripts/run.py#cli -> app/main.py#main',
    ]);
  });
});
