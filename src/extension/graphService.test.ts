import { describe, expect, it } from 'vitest';

import type { GraphPatch, GraphSnapshot, RelPath } from '../shared';
import { parseSource } from './analyzer/parser';
import type { ParsedFile } from './analyzer/types';
import { AnalysisCache } from './cache';
import type { ServiceLogger, WorkspaceReader } from './graphService';
import { GraphService } from './graphService';

/** In-memory workspace used as the service's file source. */
class InMemoryReader implements WorkspaceReader {
  public readonly files: Map<RelPath, string>;
  public readonly failingPaths = new Set<RelPath>();

  /**
   * Creates the reader.
   *
   * @param files - Initial file contents by path.
   */
  public constructor(files: Readonly<Record<string, string>>) {
    this.files = new Map(Object.entries(files));
  }

  /**
   * Lists every stored file.
   *
   * @returns File paths.
   */
  public listFiles(): Promise<RelPath[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  /**
   * Reads a stored file, failing for missing or flagged paths.
   *
   * @param filePath - File path.
   * @returns File content.
   */
  public readFile(filePath: RelPath): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined || this.failingPaths.has(filePath)) {
      return Promise.reject(new Error(`ENOENT: ${filePath}`));
    }
    return Promise.resolve(content);
  }
}

/** Logger that records messages for assertions. */
class RecordingLogger implements ServiceLogger {
  public readonly messages: { level: string; message: string }[] = [];

  /**
   * Records an info message.
   *
   * @param message - Message text.
   */
  public info(message: string): void {
    this.messages.push({ level: 'info', message });
  }

  /**
   * Records a warning.
   *
   * @param message - Message text.
   */
  public warn(message: string): void {
    this.messages.push({ level: 'warn', message });
  }

  /**
   * Records an error.
   *
   * @param message - Message text.
   */
  public error(message: string): void {
    this.messages.push({ level: 'error', message });
  }
}

/** Initial workspace: `a.ts` calls `greet` exported by `b.ts`. */
const WORKSPACE: Readonly<Record<string, string>> = {
  'src/a.ts': "import { greet } from './b';\nexport function main(): void { greet(); }",
  'src/b.ts': 'export function greet(): void {}',
  'README.md': '# not code',
  'node_modules/pkg/index.js': 'function ignored() {}',
  'src/types.d.ts': 'declare function typed(): void;',
};

/**
 * Builds a service over an in-memory workspace with a parse counter.
 *
 * @param files - Workspace files.
 * @returns The service, its collaborators and the parse counter.
 */
function setup(files: Readonly<Record<string, string>> = WORKSPACE): {
  service: GraphService;
  reader: InMemoryReader;
  logger: RecordingLogger;
  parsedPaths: RelPath[];
} {
  const reader = new InMemoryReader(files);
  const logger = new RecordingLogger();
  const parsedPaths: RelPath[] = [];
  const cache = new AnalysisCache((filePath, content): ParsedFile => {
    parsedPaths.push(filePath);
    return parseSource(filePath, content);
  });
  return {
    service: new GraphService(reader, logger, cache, { readConcurrency: 2 }),
    reader,
    logger,
    parsedPaths,
  };
}

/**
 * Lists the ids of every node of a snapshot.
 *
 * @param snapshot - Snapshot.
 * @returns Sorted node ids.
 */
function nodeIds(snapshot: GraphSnapshot): string[] {
  return snapshot.nodes.map((node) => node.id).sort();
}

/**
 * Lists the ids of every edge of a snapshot.
 *
 * @param snapshot - Snapshot.
 * @returns Sorted edge ids.
 */
function edgeIds(snapshot: GraphSnapshot): string[] {
  return snapshot.edges.map((edge) => edge.id).sort();
}

/**
 * Fails the test if a patch is null.
 *
 * @param patch - Patch returned by the service.
 * @returns The non-null patch.
 */
function expectPatch(patch: GraphPatch | null): GraphPatch {
  if (patch === null) {
    throw new Error('Expected a patch, got null.');
  }
  return patch;
}

describe('GraphService.initialize', () => {
  it('builds version 1 from analyzable files only', async () => {
    const { service, parsedPaths } = setup();
    expect(service.getSnapshot().version).toBe(0);

    const snapshot = await service.initialize();
    expect(snapshot.version).toBe(1);
    expect(parsedPaths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(nodeIds(snapshot)).toEqual(['src/a.ts', 'src/a.ts#main', 'src/b.ts', 'src/b.ts#greet']);
    expect(edgeIds(snapshot)).toEqual([
      'call:src/a.ts#main->src/b.ts#greet',
      'import:src/a.ts->src/b.ts',
    ]);
    expect(service.getSnapshot()).toBe(snapshot);
  });

  it('logs unreadable files and analyzes the rest', async () => {
    const { service, reader, logger } = setup();
    reader.failingPaths.add('src/b.ts');
    const snapshot = await service.initialize();
    expect(nodeIds(snapshot)).toEqual(['src/a.ts', 'src/a.ts#main']);
    expect(logger.messages).toContainEqual({
      level: 'error',
      message: 'Could not read "src/b.ts": ENOENT: src/b.ts',
    });
  });

  it('caps the number of analyzed files and warns', async () => {
    const reader = new InMemoryReader({ 'a.ts': '', 'b.ts': '', 'c.ts': '' });
    const logger = new RecordingLogger();
    const service = new GraphService(reader, logger, new AnalysisCache(), { maxFiles: 2 });
    const snapshot = await service.initialize();
    expect(nodeIds(snapshot)).toEqual(['a.ts', 'b.ts']);
    expect(logger.messages.some((m) => m.level === 'warn')).toBe(true);
  });

  it('rebuilds from scratch when called again', async () => {
    const { service, reader } = setup();
    await service.initialize();
    reader.files.delete('src/b.ts');
    const snapshot = await service.initialize();
    expect(snapshot.version).toBe(2);
    expect(nodeIds(snapshot)).toEqual(['src/a.ts', 'src/a.ts#main']);
  });
});

describe('GraphService.updateFile', () => {
  it('returns null and does not re-parse when content is unchanged', async () => {
    const { service, parsedPaths } = setup();
    await service.initialize();
    const parsedBefore = parsedPaths.length;
    expect(await service.updateFile('src/b.ts')).toBeNull();
    expect(parsedPaths).toHaveLength(parsedBefore);
    expect(service.getSnapshot().version).toBe(1);
  });

  it('re-parses only the changed file and updates edges of dependent files', async () => {
    const { service, reader, parsedPaths } = setup();
    await service.initialize();
    parsedPaths.length = 0;

    reader.files.set(
      'src/b.ts',
      'export function salute(): void {}\nexport function greet(): void { salute(); }',
    );
    const patch = expectPatch(await service.updateFile('src/b.ts'));

    expect(parsedPaths).toEqual(['src/b.ts']);
    expect(patch.version).toBe(2);
    expect(patch.upsertNodes.map((node) => node.id).sort()).toEqual([
      'src/b.ts', // functionIds changed
      'src/b.ts#greet', // line changed
      'src/b.ts#salute', // new
    ]);
    expect(patch.upsertEdges.map((edge) => edge.id)).toEqual([
      'call:src/b.ts#greet->src/b.ts#salute',
    ]);
    expect(patch.removeNodeIds).toEqual([]);
    expect(patch.removeEdgeIds).toEqual([]);
  });

  it('removes call edges of other files when an export is renamed', async () => {
    const { service, reader } = setup();
    await service.initialize();

    reader.files.set('src/b.ts', 'export function welcome(): void {}');
    const patch = expectPatch(await service.updateFile('src/b.ts'));

    expect(patch.removeNodeIds).toEqual(['src/b.ts#greet']);
    expect(patch.removeEdgeIds).toEqual(['call:src/a.ts#main->src/b.ts#greet']);
    expect(edgeIds(service.getSnapshot())).toEqual(['import:src/a.ts->src/b.ts']);
  });

  it('adds a new file and resolves imports that pointed to it', async () => {
    const { service, reader } = setup({
      'src/a.ts': "import { later } from './c';\nexport function main(): void { later(); }",
    });
    await service.initialize();
    expect(service.getSnapshot().edges).toEqual([]);

    reader.files.set('src/c.ts', 'export function later(): void {}');
    const patch = expectPatch(await service.updateFile('src/c.ts'));

    expect(patch.upsertEdges.map((edge) => edge.id).sort()).toEqual([
      'call:src/a.ts#main->src/c.ts#later',
      'import:src/a.ts->src/c.ts',
    ]);
  });

  it('ignores non-analyzable and unreadable files', async () => {
    const { service, logger } = setup();
    await service.initialize();
    expect(await service.updateFile('README.md')).toBeNull();
    expect(await service.updateFile('src/missing.ts')).toBeNull();
    expect(
      logger.messages.some((m) => m.level === 'error' && m.message.includes('src/missing.ts')),
    ).toBe(true);
  });

  it('serializes concurrent updates into consecutive versions', async () => {
    const { service, reader } = setup();
    await service.initialize();

    reader.files.set(
      'src/b.ts',
      'export function greet(): void {}\nexport function one(): void {}',
    );
    const first = service.updateFile('src/b.ts');
    reader.files.set('src/a.ts', 'export function main(): void {}');
    const second = service.updateFile('src/a.ts');

    const [p1, p2] = await Promise.all([first, second]);
    expect([p1?.version, p2?.version]).toEqual([2, 3]);
    expect(edgeIds(service.getSnapshot())).toEqual([]);
  });
});

describe('GraphService.removeFile', () => {
  it('drops the file, its functions and every edge touching them', async () => {
    const { service } = setup();
    await service.initialize();
    const patch = expectPatch(await service.removeFile('src/b.ts'));

    expect([...patch.removeNodeIds].sort()).toEqual(['src/b.ts', 'src/b.ts#greet']);
    expect([...patch.removeEdgeIds].sort()).toEqual([
      'call:src/a.ts#main->src/b.ts#greet',
      'import:src/a.ts->src/b.ts',
    ]);
    expect(nodeIds(service.getSnapshot())).toEqual(['src/a.ts', 'src/a.ts#main']);
  });

  it('returns null for files that are not in the graph', async () => {
    const { service } = setup();
    await service.initialize();
    expect(await service.removeFile('src/unknown.ts')).toBeNull();
  });
});
