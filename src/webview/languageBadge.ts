/**
 * Language badges shown on file nodes and in search results.
 */
import type { RelPath } from '../shared';

/** Languages with their own badge style. */
export type BadgeLanguage =
  'typescript' | 'javascript' | 'python' | 'java' | 'csharp' | 'go' | 'other';

/** Label and style of a file's badge. */
export interface LanguageBadge {
  /** Short text, e.g. `TS`, `PY`, `C#`. */
  readonly label: string;
  /** Style key (CSS class `cg-lang--<language>`). */
  readonly language: BadgeLanguage;
  /** Full language name, for tooltips and screen readers. */
  readonly title: string;
}

/** Badge of each supported extension. */
const BADGES: Readonly<Record<string, LanguageBadge>> = {
  ts: { label: 'TS', language: 'typescript', title: 'TypeScript' },
  tsx: { label: 'TSX', language: 'typescript', title: 'TypeScript (JSX)' },
  js: { label: 'JS', language: 'javascript', title: 'JavaScript' },
  jsx: { label: 'JSX', language: 'javascript', title: 'JavaScript (JSX)' },
  py: { label: 'PY', language: 'python', title: 'Python' },
  java: { label: 'JAVA', language: 'java', title: 'Java' },
  cs: { label: 'C#', language: 'csharp', title: 'C#' },
  go: { label: 'GO', language: 'go', title: 'Go' },
};

/**
 * Returns the badge of a file from its extension.
 *
 * @param filePath - Workspace-relative path.
 * @returns The badge (an upper-cased extension for unknown languages).
 */
export function getLanguageBadge(filePath: RelPath): LanguageBadge {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  return (
    BADGES[extension] ?? {
      label: extension.toUpperCase().slice(0, 4),
      language: 'other',
      title: extension === '' ? 'File' : extension,
    }
  );
}
