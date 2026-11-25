/**
 * Small line icons (16×16, drawn with `currentColor`) used by the sidebar
 * and the toolbar, so the webview needs no icon font.
 */
import type { JSX, ReactNode } from 'react';

/** Names of the available icons. */
export type IconName =
  | 'search'
  | 'connections'
  | 'filter'
  | 'focus'
  | 'view'
  | 'close'
  | 'eye'
  | 'eyeOff'
  | 'chevronRight'
  | 'chevronDown'
  | 'chevronUp'
  | 'sync'
  | 'expand'
  | 'expandAll'
  | 'collapseAll'
  | 'relayout'
  | 'download';

/** Paths of each icon, in a 16×16 view box. */
const ICON_PATHS: Readonly<Record<IconName, ReactNode>> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </>
  ),
  connections: (
    <>
      <circle cx="3.5" cy="8" r="2" />
      <circle cx="12.5" cy="3.5" r="2" />
      <circle cx="12.5" cy="12.5" r="2" />
      <path d="M5.3 7.1 10.7 4.4M5.3 8.9l5.4 2.7" />
    </>
  ),
  filter: <path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6Z" />,
  focus: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  view: (
    <>
      <path d="M8 2 14 5 8 8 2 5Z" />
      <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M6.6 3.7A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4M4.2 4.9A11 11 0 0 0 1.5 8S4 12.5 8 12.5a6 6 0 0 0 3.3-1" />
      <path d="m2 2 12 12" />
    </>
  ),
  chevronRight: <path d="m6 4 4 4-4 4" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  chevronUp: <path d="m4 10 4-4 4 4" />,
  sync: (
    <>
      <path d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5A5 5 0 0 0 12.4 11" />
      <path d="M3.5 2.5V5H6M12.5 13.5V11H10" />
    </>
  ),
  expand: <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />,
  expandAll: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M8 5v6M5 8h6" />
    </>
  ),
  collapseAll: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5 8h6" />
    </>
  ),
  relayout: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
      <path d="M9.5 4.5H12a1 1 0 0 1 1 1V7M6.5 11.5H4a1 1 0 0 1-1-1V9" />
    </>
  ),
  download: <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11v2.5h11V11" />,
};

/** Props of {@link Icon}. */
interface IconProps {
  readonly name: IconName;
  /** Size in pixels (square). */
  readonly size?: number;
}

/**
 * Decorative line icon; screen readers ignore it (the surrounding control
 * carries the label).
 *
 * @param props - Icon name and size.
 * @returns The SVG element.
 */
export function Icon({ name, size = 16 }: IconProps): JSX.Element {
  return (
    <svg
      className="cg-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
