import type { JSX } from 'react';

import type { RelPath } from '../shared';
import { getLanguageBadge } from './languageBadge';

/** Props of {@link LanguageBadgeView}. */
interface LanguageBadgeViewProps {
  /** File the badge describes. */
  readonly filePath: RelPath;
}

/**
 * Small colored tag with the language of a file (`TS`, `PY`, `JAVA`, `C#`, `GO`…).
 *
 * @param props - File path.
 * @returns The badge element.
 */
export function LanguageBadgeView({ filePath }: LanguageBadgeViewProps): JSX.Element {
  const badge = getLanguageBadge(filePath);
  return (
    <span className={`cg-lang cg-lang--${badge.language}`} title={badge.title}>
      {badge.label}
    </span>
  );
}
