/**
 * Helpers shared by the Tree-sitter parsers of namespace-based languages
 * (Java, C#, Go): function drafts that collect calls and local variable
 * types, and small syntax-tree utilities.
 */
import type { Node } from '@vscode/tree-sitter-wasm';

import type { ParsedCall, ParsedFunction } from './types';

/** A function being parsed: its declaration, its calls and what its variables are. */
export interface FunctionDraft {
  readonly fn: Omit<ParsedFunction, 'calls'>;
  readonly calls: ParsedCall[];
  /** Local variable and parameter types, by name. */
  readonly variables: Map<string, string>;
  /** Field types of the enclosing type, by name. */
  readonly fields: Readonly<Record<string, string>>;
  /** First character of the declaration (parameters included). */
  readonly startIndex: number;
  /** End of the declaration (exclusive). */
  readonly endIndex: number;
}

/**
 * Finds the draft whose range contains a position. Drafts must be sorted by
 * start and must not overlap.
 *
 * @param drafts - Function drafts sorted by `startIndex`.
 * @param index - Character offset in the file.
 * @returns The enclosing draft, or `undefined` outside any function.
 */
export function findEnclosingDraft(
  drafts: readonly FunctionDraft[],
  index: number,
): FunctionDraft | undefined {
  let low = 0;
  let high = drafts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const draft = drafts[middle];
    if (draft === undefined) {
      return undefined;
    }
    if (index < draft.startIndex) {
      high = middle - 1;
    } else if (index >= draft.endIndex) {
      low = middle + 1;
    } else {
      return draft;
    }
  }
  return undefined;
}

/**
 * 1-based first line of a node.
 *
 * @param node - Syntax node.
 * @returns The line.
 */
export function startLine(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * 1-based last line of a node.
 *
 * @param node - Syntax node.
 * @returns The line.
 */
export function endLine(node: Node): number {
  return node.endPosition.row + 1;
}

/**
 * Named children of a node, without the `null` entries of the WASM binding.
 *
 * @param node - Syntax node.
 * @returns The named children.
 */
export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

/**
 * Children of a node with a given field name.
 *
 * @param node - Syntax node.
 * @param field - Field name.
 * @returns The children.
 */
export function fieldChildren(node: Node, field: string): Node[] {
  return node.childrenForFieldName(field).filter((child): child is Node => child !== null);
}

/**
 * Tells whether a node has an unnamed child with a given text (a keyword such
 * as `static`, or a modifier in grammars that keep them anonymous).
 *
 * @param node - Syntax node.
 * @param text - Keyword.
 * @returns `true` when the keyword is a direct child.
 */
export function hasKeyword(node: Node, text: string): boolean {
  return node.children.some((child) => child !== null && child.text === text);
}

/**
 * Sorts drafts by position, as {@link findEnclosingDraft} requires.
 *
 * @param drafts - Drafts in any order.
 * @returns The same drafts, sorted.
 */
export function sortDrafts(drafts: FunctionDraft[]): FunctionDraft[] {
  return drafts.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Finishes the drafts into parsed functions.
 *
 * @param drafts - Drafts in source order.
 * @returns The parsed functions.
 */
export function toParsedFunctions(drafts: readonly FunctionDraft[]): ParsedFunction[] {
  return drafts.map((draft) => ({ ...draft.fn, calls: draft.calls }));
}
