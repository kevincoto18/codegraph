/**
 * Fuzzy search over the files and functions of the graph.
 *
 * The index is built once per graph version (names lower-cased and word
 * boundaries precomputed), so each keystroke only scores entries. Matches are
 * ranked: exact name, prefix, substring at a word boundary, substring,
 * initials (`gvc` → `GraphViewContent`) and finally any subsequence.
 */
import type { GraphSnapshot, NodeKind, RelPath } from '../shared';

/** A searchable file or function. */
export interface SearchEntry {
  readonly id: string;
  readonly kind: NodeKind;
  /** Name shown in the results: file name or qualified function name. */
  readonly name: string;
  /** Secondary text: folder of a file, or file of a function. */
  readonly detail: RelPath;
  /** Id of the file that contains a function; `null` for files. */
  readonly fileId: string | null;
  /** Lower-cased name. */
  readonly nameLower: string;
  /** Lower-cased full path of a file (folders included); empty for functions. */
  readonly pathLower: string;
  /** `1` where a word starts in the name (start, after `._-/ `, camelCase hump, digits). */
  readonly boundaries: Uint8Array;
}

/** Searchable entries of one graph version. */
export interface SearchIndex {
  readonly entries: readonly SearchEntry[];
}

/** A ranked search result. */
export interface SearchHit {
  readonly entry: SearchEntry;
  /** Higher is better. */
  readonly score: number;
  /** Indices of the name characters that matched, ascending (for highlighting). */
  readonly positions: readonly number[];
}

/** Score of one query token against one entry, or `null` when it does not match. */
interface TokenMatch {
  readonly score: number;
  readonly positions: readonly number[];
}

/** Characters after which a new word starts. */
const SEPARATORS = new Set(['.', '_', '-', '/', ' ', '$', '#', ':']);

/**
 * Marks where words start in a name.
 *
 * @param name - Original (case-preserving) name.
 * @returns One flag per character.
 */
export function computeBoundaries(name: string): Uint8Array {
  const flags = new Uint8Array(name.length);
  for (let index = 0; index < name.length; index += 1) {
    const char = name.charAt(index);
    const previous = index === 0 ? '' : name.charAt(index - 1);
    const isUpper = char !== char.toLowerCase();
    const previousIsLower =
      previous !== '' && previous === previous.toLowerCase() && previous !== previous.toUpperCase();
    const isDigit = char >= '0' && char <= '9';
    const previousIsDigit = previous >= '0' && previous <= '9';
    if (
      index === 0 ||
      SEPARATORS.has(previous) ||
      (isUpper && previousIsLower) ||
      (isDigit && !previousIsDigit)
    ) {
      flags[index] = SEPARATORS.has(char) ? 0 : 1;
    }
  }
  return flags;
}

/**
 * Builds the search index of a graph.
 *
 * @param snapshot - Graph to index.
 * @returns One entry per file and function, in graph order.
 */
export function buildSearchIndex(snapshot: GraphSnapshot): SearchIndex {
  const entries: SearchEntry[] = snapshot.nodes.map((node) => {
    if (node.kind === 'file') {
      const slash = node.filePath.lastIndexOf('/');
      const name = node.filePath.slice(slash + 1);
      return {
        id: node.id,
        kind: 'file',
        name,
        detail: slash === -1 ? '' : node.filePath.slice(0, slash),
        fileId: null,
        nameLower: name.toLowerCase(),
        pathLower: node.filePath.toLowerCase(),
        boundaries: computeBoundaries(name),
      };
    }
    return {
      id: node.id,
      kind: 'function',
      name: node.qualifiedName,
      detail: node.filePath,
      fileId: node.fileId,
      nameLower: node.qualifiedName.toLowerCase(),
      pathLower: '',
      boundaries: computeBoundaries(node.qualifiedName),
    };
  });
  return { entries };
}

/**
 * Builds the list `[start, start + 1, …, start + length - 1]`.
 *
 * @param start - First index.
 * @param length - Number of indices.
 * @returns The consecutive indices.
 */
function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

/**
 * Matches the token's characters, in order, on word starts only (initials).
 *
 * @param entry - Entry to match.
 * @param token - Lower-cased token.
 * @returns The matched positions, or `null`.
 */
function matchInitials(entry: SearchEntry, token: string): number[] | null {
  const positions: number[] = [];
  let from = 0;
  for (const char of token) {
    let found = -1;
    for (let index = from; index < entry.nameLower.length; index += 1) {
      if (entry.boundaries[index] === 1 && entry.nameLower.charAt(index) === char) {
        found = index;
        break;
      }
    }
    if (found === -1) {
      return null;
    }
    positions.push(found);
    from = found + 1;
  }
  return positions;
}

/**
 * Matches the token's characters, in order, anywhere in the name (greedy).
 *
 * @param text - Lower-cased text.
 * @param token - Lower-cased token.
 * @returns The matched positions, or `null`.
 */
function matchSubsequence(text: string, token: string): number[] | null {
  const positions: number[] = [];
  let from = 0;
  for (const char of token) {
    const found = text.indexOf(char, from);
    if (found === -1) {
      return null;
    }
    positions.push(found);
    from = found + 1;
  }
  return positions;
}

/**
 * Scores one query token against an entry's name (and a file's path).
 *
 * @param entry - Entry to score.
 * @param token - Lower-cased, non-empty token.
 * @returns The score and matched name positions, or `null` without a match.
 */
function matchToken(entry: SearchEntry, token: string): TokenMatch | null {
  const name = entry.nameLower;
  const extraLength = name.length - token.length;
  if (name === token) {
    return { score: 1000, positions: range(0, token.length) };
  }
  const index = name.indexOf(token);
  if (index === 0) {
    return { score: 900 - extraLength, positions: range(0, token.length) };
  }
  if (index > 0) {
    const atBoundary = entry.boundaries[index] === 1;
    return {
      score: (atBoundary ? 800 : 700) - index - extraLength / 2,
      positions: range(index, token.length),
    };
  }
  if (token.length > 1) {
    const initials = matchInitials(entry, token);
    if (initials !== null) {
      return { score: 600 - extraLength / 4, positions: initials };
    }
    const subsequence = matchSubsequence(name, token);
    if (subsequence !== null) {
      const first = subsequence[0] ?? 0;
      const last = subsequence.at(-1) ?? 0;
      const gaps = last - first + 1 - token.length;
      const boundaryHits = subsequence.filter(
        (position) => entry.boundaries[position] === 1,
      ).length;
      return { score: 400 + boundaryHits * 15 - gaps * 3 - first, positions: subsequence };
    }
  }
  // Files also match on their folders (e.g. `webview` finds every file in `src/webview`).
  if (entry.pathLower.includes(token)) {
    return { score: 200 - extraLength / 4, positions: [] };
  }
  return null;
}

/**
 * Splits a query into lower-cased tokens (every token must match).
 *
 * @param query - Raw query.
 * @returns The tokens; empty for a blank query.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '');
}

/**
 * Matches an entry against a one-token query (the common case, without extra allocations).
 *
 * @param entry - Entry to match.
 * @param token - Lower-cased token.
 * @returns The hit, or `null`.
 */
function matchSingle(entry: SearchEntry, token: string): SearchHit | null {
  const match = matchToken(entry, token);
  return match === null ? null : { entry, score: match.score, positions: match.positions };
}

/**
 * Matches an entry against several tokens, which must all match.
 *
 * @param entry - Entry to match.
 * @param tokens - Lower-cased tokens.
 * @returns The hit with the summed score and merged positions, or `null`.
 */
function matchAll(entry: SearchEntry, tokens: readonly string[]): SearchHit | null {
  let score = 0;
  const positions = new Set<number>();
  for (const token of tokens) {
    const match = matchToken(entry, token);
    if (match === null) {
      return null;
    }
    score += match.score;
    match.positions.forEach((position) => positions.add(position));
  }
  return { entry, score, positions: [...positions].sort((a, b) => a - b) };
}

/**
 * Orders hits: best score first, then shorter names, files before functions,
 * then by name (plain code-unit order, much faster than `localeCompare`).
 *
 * @param a - First hit.
 * @param b - Second hit.
 * @returns A negative number when `a` comes first.
 */
function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.entry.name.length !== b.entry.name.length) {
    return a.entry.name.length - b.entry.name.length;
  }
  if (a.entry.kind !== b.entry.kind) {
    return a.entry.kind === 'file' ? -1 : 1;
  }
  return a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0;
}

/**
 * Searches the index and ranks the results.
 *
 * @param index - Search index.
 * @param query - Raw query; whitespace separates tokens that must all match.
 * @returns The hits, best first (ties: shorter name, then files, then name order).
 */
export function searchIndex(index: SearchIndex, query: string): SearchHit[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return [];
  }
  const hits: SearchHit[] = [];
  for (const entry of index.entries) {
    const hit = tokens.length === 1 ? matchSingle(entry, tokens[0] ?? '') : matchAll(entry, tokens);
    if (hit !== null) {
      hits.push(hit);
    }
  }
  return hits.sort(compareHits);
}

/**
 * Splits a name into highlighted and plain segments.
 *
 * @param name - Name to display.
 * @param positions - Matched character indices, ascending.
 * @returns Consecutive segments covering the whole name.
 */
export function splitHighlights(
  name: string,
  positions: readonly number[],
): { readonly text: string; readonly highlighted: boolean }[] {
  const marked = new Set(positions);
  const segments: { text: string; highlighted: boolean }[] = [];
  for (let index = 0; index < name.length; index += 1) {
    const highlighted = marked.has(index);
    const last = segments.at(-1);
    if (last?.highlighted === highlighted) {
      last.text += name.charAt(index);
    } else {
      segments.push({ text: name.charAt(index), highlighted });
    }
  }
  return segments;
}
