import { describe, expect, it, vi } from 'vitest';

import type { GraphPatch, GraphSnapshot, RelPath } from '../shared';
import { parseSource } from './analyzer/parser';
import type { ParsedFile } from './analyzer/types';
import type { CacheEntry, FileStamp } from './cache';
import { AnalysisCache } from './cache';
import type { CacheStore, GraphStore } from './cacheStore';
import type { ParseJob, ParsePool } from './parsePool';
import type { GraphSnapshot as Snapshot } from '../shared';
import type { ServiceLogger, WorkspaceReader } from './graphService';
import { GraphService, MIN_FILES_FOR_WORKERS } from './graphService';

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

  it('coalesces changes queued together into a single patch', async () => {
    const { service, reader, parsedPaths } = setup();
    await service.initialize();
    parsedPaths.length = 0;

    reader.files.set(
      'src/b.ts',
      'export function greet(): void {}\nexport function one(): void {}',
    );
    const first = service.updateFile('src/b.ts');
    reader.files.set('src/a.ts', 'export function main(): void {}');
    const second = service.updateFile('src/a.ts');
    const third = service.updateFile('src/b.ts'); // duplicate in the same batch

    const [p1, p2, p3] = await Promise.all([first, second, third]);
    expect(p1).toBe(p2);
    expect(p1).toBe(p3);
    expect(p1?.version).toBe(2);
    expect(parsedPaths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(edgeIds(service.getSnapshot())).toEqual([]);
    expect(service.performance.get('update.batch')?.last).toBe(2);
  });

  it('applies changes submitted during a batch in the next batch', async () => {
    const { service, reader } = setup();
    await service.initialize();

    reader.files.set(
      'src/b.ts',
      'export function greet(): void {}\nexport function one(): void {}',
    );
    const first = service.updateFile('src/b.ts');
    const firstPatch = await first;
    const second = service.removeFile('src/a.ts');
    const secondPatch = await second;
    expect([firstPatch?.version, secondPatch?.version]).toEqual([2, 3]);
    expect(service.hasFile('src/a.ts')).toBe(false);
    expect(service.getFilePaths()).toEqual(['src/b.ts']);
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

/** Reader that also reports file stamps and counts reads. */
class StampedReader extends InMemoryReader {
  public readonly stamps = new Map<RelPath, FileStamp>();
  public readonly reads: RelPath[] = [];

  /**
   * Reads a file and records the read.
   *
   * @param filePath - File path.
   * @returns File content.
   */
  public override readFile(filePath: RelPath): Promise<string> {
    this.reads.push(filePath);
    return super.readFile(filePath);
  }

  /**
   * Returns the stamp of a file (mtime 1 unless set).
   *
   * @param filePath - File path.
   * @returns The stamp.
   */
  public stat(filePath: RelPath): Promise<FileStamp> {
    const size = this.files.get(filePath)?.length ?? 0;
    return Promise.resolve(this.stamps.get(filePath) ?? { mtime: 1, size });
  }
}

/** Store that keeps entries in memory. */
class MemoryStore implements CacheStore {
  public entries: CacheEntry[] = [];
  public saves = 0;

  /**
   * Returns the saved entries.
   *
   * @returns Saved entries.
   */
  public load(): Promise<CacheEntry[]> {
    return Promise.resolve([...this.entries]);
  }

  /**
   * Saves entries.
   *
   * @param entries - Entries to save.
   */
  public save(entries: readonly CacheEntry[]): Promise<void> {
    this.entries = [...entries];
    this.saves += 1;
    return Promise.resolve();
  }
}

describe('GraphService cache reuse', () => {
  it('does not read files whose stamp did not change', async () => {
    const reader = new StampedReader(WORKSPACE);
    const service = new GraphService(reader, new RecordingLogger(), new AnalysisCache());
    await service.initialize();
    expect(reader.reads.sort()).toEqual(['src/a.ts', 'src/b.ts']);

    reader.reads.length = 0;
    reader.stamps.set('src/b.ts', { mtime: 2, size: 1 });
    const snapshot = await service.initialize();
    expect(reader.reads).toEqual(['src/b.ts']);
    expect(snapshot.nodes).toHaveLength(4);
    expect(service.performance.get('scan.reused')?.last).toBe(1);
  });

  it('restores the persisted cache in a new session without reading files', async () => {
    const store = new MemoryStore();
    const first = new GraphService(new StampedReader(WORKSPACE), new RecordingLogger(), undefined, {
      store,
    });
    const expected = await first.initialize();
    await first.dispose();
    expect(store.entries.map((entry) => entry.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const reader = new StampedReader(WORKSPACE);
    const logger = new RecordingLogger();
    const second = new GraphService(reader, logger, undefined, { store });
    const snapshot = await second.initialize();
    expect(reader.reads).toEqual([]);
    expect(snapshot.nodes).toEqual(expected.nodes);
    expect(snapshot.edges).toEqual(expected.edges);
    expect(logger.messages.some((m) => m.message.includes('Loaded 2 cached files'))).toBe(true);
  });

  it('persists live updates once the burst settles', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const reader = new StampedReader(WORKSPACE);
      const service = new GraphService(reader, new RecordingLogger(), undefined, {
        store,
        persistDelayMs: 100,
      });
      await service.initialize();
      await service.dispose();
      const savesAfterScan = store.saves;

      reader.files.set('src/b.ts', 'export function welcome(): void {}');
      await service.updateFile('src/b.ts');
      expect(store.saves).toBe(savesAfterScan);
      await vi.advanceTimersByTimeAsync(100);
      await service.dispose();
      expect(store.saves).toBe(savesAfterScan + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Graph store that keeps the graph in memory. */
class MemoryGraphStore implements GraphStore {
  public graph: Snapshot | null = null;

  /**
   * Returns the saved graph.
   *
   * @returns The graph, or `null`.
   */
  public load(): Promise<Snapshot | null> {
    return Promise.resolve(this.graph);
  }

  /**
   * Saves a graph.
   *
   * @param snapshot - Graph to save.
   */
  public save(snapshot: Snapshot): Promise<void> {
    this.graph = snapshot;
    return Promise.resolve();
  }
}

describe('GraphService saved graph', () => {
  it('shows the previous graph and patches it after the rescan', async () => {
    const graphStore = new MemoryGraphStore();
    const first = new GraphService(
      new InMemoryReader(WORKSPACE),
      new RecordingLogger(),
      undefined,
      {
        graphStore,
      },
    );
    await first.initialize();
    await first.dispose();
    expect(graphStore.graph?.version).toBe(1);

    const reader = new InMemoryReader(WORKSPACE);
    reader.files.set(
      'src/b.ts',
      'export function greet(): void {}\nexport function bye(): void {}',
    );
    const second = new GraphService(reader, new RecordingLogger(), undefined, { graphStore });
    const saved = await second.loadSavedGraph();
    expect(saved?.version).toBe(1);
    expect(second.hasScanned).toBe(false);
    expect(await second.loadSavedGraph()).toBeNull(); // only once

    if (saved === null) {
      throw new Error('Expected a saved graph.');
    }
    const { snapshot, patch } = await second.revalidate(saved);
    expect(snapshot.version).toBe(2);
    expect(second.hasScanned).toBe(true);
    expect(patch?.version).toBe(2);
    expect(patch?.upsertNodes.map((node) => node.id).sort()).toEqual(['src/b.ts', 'src/b.ts#bye']);
  });

  it('continues the numbering of the saved graph', async () => {
    const graphStore = new MemoryGraphStore();
    graphStore.graph = { version: 3, nodes: [], edges: [] };
    const service = new GraphService(
      new InMemoryReader(WORKSPACE),
      new RecordingLogger(),
      undefined,
      {
        graphStore,
      },
    );
    const saved = await service.loadSavedGraph();
    if (saved === null) {
      throw new Error('Expected a saved graph.');
    }
    const { snapshot, patch } = await service.revalidate(saved);
    expect(snapshot.version).toBe(4);
    expect(patch?.version).toBe(4);
    expect(patch?.upsertNodes).toHaveLength(4);
  });

  it('has nothing to show without a store', async () => {
    const { service } = setup();
    expect(await service.loadSavedGraph()).toBeNull();
  });
});

/**
 * Builds a workspace of many small files.
 *
 * @param count - Number of files.
 * @returns File contents by path.
 */
function manyFiles(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `src/f${String(index)}.ts`,
      `export function f${String(index)}(): void {}`,
    ]),
  );
}

describe('GraphService parallel parsing', () => {
  it('parses large scans with the pool and disposes it', async () => {
    const parsedJobs: ParseJob[] = [];
    let disposed = false;
    const pool: ParsePool = {
      parseAll: (jobs) => {
        parsedJobs.push(...jobs);
        return Promise.resolve(jobs.map((job) => parseSource(job.filePath, job.content)));
      },
      dispose: () => {
        disposed = true;
        return Promise.resolve();
      },
    };
    const service = new GraphService(
      new InMemoryReader(manyFiles(MIN_FILES_FOR_WORKERS)),
      new RecordingLogger(),
      undefined,
      {
        createParsePool: () => pool,
      },
    );
    const snapshot = await service.initialize();
    expect(parsedJobs).toHaveLength(MIN_FILES_FOR_WORKERS);
    expect(disposed).toBe(true);
    expect(snapshot.nodes).toHaveLength(2 * MIN_FILES_FOR_WORKERS);
  });

  it('keeps small scans inline', async () => {
    let created = false;
    const service = new GraphService(
      new InMemoryReader(WORKSPACE),
      new RecordingLogger(),
      undefined,
      {
        createParsePool: () => {
          created = true;
          return null;
        },
      },
    );
    await service.initialize();
    expect(created).toBe(false);
  });

  it('falls back to inline parsing when the pool fails', async () => {
    const logger = new RecordingLogger();
    const pool: ParsePool = {
      parseAll: () => Promise.reject(new Error('worker crashed')),
      dispose: () => Promise.resolve(),
    };
    const service = new GraphService(
      new InMemoryReader(manyFiles(MIN_FILES_FOR_WORKERS)),
      logger,
      undefined,
      {
        createParsePool: () => pool,
      },
    );
    const snapshot = await service.initialize();
    expect(snapshot.nodes).toHaveLength(2 * MIN_FILES_FOR_WORKERS);
    expect(logger.messages.some((m) => m.message.includes('worker crashed'))).toBe(true);
  });
});
