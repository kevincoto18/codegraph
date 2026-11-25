/**
 * Reads a unified diff (`git diff` output for one file) into the lines that
 * changed in the new version of the file.
 */

/** Changes of one file, in line numbers of its new (working tree) version. */
export interface ParsedDiff {
  /** 1-based lines added or modified, ascending. */
  readonly addedLines: readonly number[];
  /**
   * Where lines were removed: each entry is the line of the new file that
   * now follows the removed block (removed at the very end: line count + 1).
   */
  readonly removals: readonly Removal[];
  /** Added lines that are blank or only a comment (no behavior change). */
  readonly trivialLines: ReadonlySet<number>;
  readonly added: number;
  readonly removed: number;
  /** Whether git reported a binary file (no line information). */
  readonly binary: boolean;
}

/** A block of removed lines. */
export interface Removal {
  /** Line of the new file that now follows the block. */
  readonly before: number;
  readonly count: number;
  /** First line added in its place, when the block was replaced (a modification). */
  readonly replacedBy?: number;
  /** Whether every removed line was blank or only a comment. */
  readonly trivial: boolean;
}

/** A line that is blank or starts with a comment marker (`//`, `#`, `/*` or `*`). */
const TRIVIAL_LINE = /^\s*(?:$|\/\/|#|\/\*|\*)/;

/** Header of a hunk: `@@ -a,b +c,d @@`. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses the unified diff of a single file.
 *
 * @param patch - Diff text (headers are skipped).
 * @returns The changed lines.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const addedLines: number[] = [];
  const trivialLines = new Set<number>();
  const removals: Removal[] = [];
  let removed = 0;
  let binary = false;
  let newLine = 0;
  let inHunk = false;
  let pendingRemoval = 0;
  let pendingTrivial = true;

  /**
   * Records the block of removed lines that ends before `newLine`.
   *
   * @param replaced - Whether lines are added right after it (a modification).
   */
  const flushRemoval = (replaced = false): void => {
    if (pendingRemoval > 0) {
      removals.push(
        replaced
          ? { before: newLine, count: pendingRemoval, replacedBy: newLine, trivial: pendingTrivial }
          : { before: newLine, count: pendingRemoval, trivial: pendingTrivial },
      );
      pendingRemoval = 0;
      pendingTrivial = true;
    }
  };

  for (const line of patch.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      flushRemoval();
      newLine = Number(header[1]);
      // `+0,0` (file emptied): removed lines sit before line 1.
      if (newLine === 0) {
        newLine = 1;
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('Binary files ')) {
        binary = true;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      flushRemoval();
      inHunk = false;
      continue;
    }
    const marker = line.charAt(0);
    if (marker === '+') {
      flushRemoval(true);
      addedLines.push(newLine);
      if (TRIVIAL_LINE.test(line.slice(1))) {
        trivialLines.add(newLine);
      }
      newLine += 1;
    } else if (marker === '-') {
      pendingRemoval += 1;
      pendingTrivial &&= TRIVIAL_LINE.test(line.slice(1));
      removed += 1;
    } else if (marker === ' ') {
      flushRemoval();
      newLine += 1;
    }
    // `\ No newline at end of file` and blank trailing lines carry no change.
  }
  flushRemoval();
  return { addedLines, removals, trivialLines, added: addedLines.length, removed, binary };
}
