/**
 * `WorkspaceReader` implementations for running the graph service outside VS Code.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { toPosixPath } from '../../src/shared';
import type { WorkspaceReader } from '../../src/extension/graphService';

/** Folder name under the OS temp directory that holds generated projects. */
const STRESS_ROOT_NAME = 'codegraph-stress';

/**
 * Returns the folder where a generated project is written. It lives in the
 * OS temp directory, outside the repository (and outside OneDrive).
 *
 * @param name - Project name, e.g. `L`.
 * @returns Absolute folder path.
 */
export function stressProjectDir(name: string): string {
  return join(tmpdir(), STRESS_ROOT_NAME, name);
}

/**
 * Writes an in-memory project to disk, replacing any previous content.
 *
 * @param files - File contents by relative POSIX path.
 * @param root - Destination folder; must be inside the stress temp folder.
 * @throws Error if `root` is outside the stress temp folder (safety guard).
 */
export async function writeProject(
  files: ReadonlyMap<string, string>,
  root: string,
): Promise<void> {
  const allowedRoot = resolve(tmpdir(), STRESS_ROOT_NAME) + sep;
  if (!resolve(root).startsWith(allowedRoot)) {
    throw new Error(`Refusing to write outside ${allowedRoot}: ${root}`);
  }
  await rm(root, { recursive: true, force: true });
  const folders = new Set([...files.keys()].map((path) => dirname(join(root, path))));
  await Promise.all([...folders].map((folder) => mkdir(folder, { recursive: true })));
  const entries = [...files.entries()];
  const batchSize = 256;
  for (let start = 0; start < entries.length; start += batchSize) {
    await Promise.all(
      entries
        .slice(start, start + batchSize)
        .map(([path, content]) => writeFile(join(root, path), content)),
    );
  }
}

/**
 * Reads a real folder from disk. An overlay of in-memory contents takes
 * precedence over disk, so tests can simulate edits without touching files.
 */
export class FileSystemReader implements WorkspaceReader {
  /** In-memory edits; `null` marks a deleted file. */
  public readonly overlay = new Map<string, string | null>();

  /**
   * Creates the reader.
   *
   * @param root - Absolute folder path.
   */
  public constructor(private readonly root: string) {}

  /**
   * Lists every file under the root recursively.
   *
   * @returns Relative POSIX paths.
   */
  public async listFiles(): Promise<string[]> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => toPosixPath(join(entry.parentPath, entry.name).slice(this.root.length + 1)))
      .filter((path) => this.overlay.get(path) !== null);
  }

  /**
   * Reads a file, preferring the overlay.
   *
   * @param filePath - Relative POSIX path.
   * @returns The file content.
   * @throws Error if the overlay marks the file as deleted.
   */
  public async readFile(filePath: string): Promise<string> {
    const overlaid = this.overlay.get(filePath);
    if (overlaid === null) {
      throw new Error(`ENOENT (deleted in overlay): ${filePath}`);
    }
    return overlaid ?? readFile(join(this.root, filePath), 'utf8');
  }
}

/** Serves files from memory (no I/O), for UI stress setup. */
export class MemoryReader implements WorkspaceReader {
  /**
   * Creates the reader.
   *
   * @param files - File contents by relative POSIX path.
   */
  public constructor(private readonly files: ReadonlyMap<string, string>) {}

  /**
   * Lists every file.
   *
   * @returns Relative POSIX paths.
   */
  public listFiles(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  /**
   * Reads a file.
   *
   * @param filePath - Relative POSIX path.
   * @returns The file content.
   */
  public readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath);
    return content === undefined
      ? Promise.reject(new Error(`ENOENT: ${filePath}`))
      : Promise.resolve(content);
  }
}

/** Logger that discards info/warnings and prints errors. */
export const quietLogger = {
  /** Ignores informational messages. */
  info(): void {
    // Intentionally silent: benchmarks print their own report.
  },
  /** Ignores warnings. */
  warn(): void {
    // Intentionally silent: benchmarks print their own report.
  },
  /**
   * Prints errors.
   *
   * @param message - Error text.
   */
  error(message: string): void {
    console.error(message);
  },
};

/**
 * Writes a report as Markdown and JSON under `bench/results/`.
 *
 * @param name - Report name, e.g. `stress`.
 * @param markdown - Human-readable report.
 * @param data - Machine-readable results.
 * @returns Paths of the written files.
 */
export async function saveReport(
  name: string,
  markdown: string,
  data: unknown,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const folder = join('bench', 'results');
  await mkdir(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const markdownPath = join(folder, `${name}-${stamp}.md`);
  const jsonPath = join(folder, `${name}-${stamp}.json`);
  await writeFile(markdownPath, markdown);
  await writeFile(jsonPath, JSON.stringify(data, null, 2));
  return { markdownPath, jsonPath };
}

/**
 * Forces a garbage collection when Node runs with `--expose-gc`.
 *
 * @returns `true` if a collection ran.
 */
export function collectGarbage(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) {
    return false;
  }
  gc();
  return true;
}
