/**
 * Small form controls of the sidebar: a switch row and a segmented control.
 */
import type { JSX, ReactNode } from 'react';
import { useId } from 'react';

/** Props of {@link SwitchRow}. */
interface SwitchRowProps {
  readonly label: string;
  /** Secondary text under the label. */
  readonly description?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  /** Visual shown before the label (e.g. a line sample). */
  readonly leading?: ReactNode;
}

/**
 * Labeled on/off switch spanning the whole row, so the full row is clickable.
 *
 * @param props - Label, state and callback.
 * @returns The switch row element.
 */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  leading,
}: SwitchRowProps): JSX.Element {
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={description === undefined ? undefined : descriptionId}
      className="cg-switch-row"
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
    >
      {leading !== undefined && <span className="cg-switch-row__leading">{leading}</span>}
      <span className="cg-switch-row__text">
        <span className="cg-switch-row__label">{label}</span>
        {description !== undefined && (
          <span id={descriptionId} className="cg-switch-row__description">
            {description}
          </span>
        )}
      </span>
      <span className="cg-switch" aria-hidden="true">
        <span className="cg-switch__thumb" />
      </span>
    </button>
  );
}

/** One option of a {@link Segmented} control. */
export interface SegmentOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  /** Tooltip. */
  readonly title?: string;
}

/** Props of {@link Segmented}. */
interface SegmentedProps<T extends string | number> {
  /** Accessible name of the group. */
  readonly label: string;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}

/**
 * Row of mutually exclusive options (like radio buttons).
 *
 * @param props - Options, selected value and callback.
 * @returns The segmented control element.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: SegmentedProps<T>): JSX.Element {
  return (
    <div className="cg-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="cg-segmented__option"
          title={option.title}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Props of {@link SidebarSection}. */
interface SidebarSectionProps {
  readonly title: string;
  /** Optional control at the right of the title (e.g. a reset button). */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Titled group of controls inside a sidebar tab.
 *
 * @param props - Title, optional action and content.
 * @returns The section element.
 */
export function SidebarSection({ title, action, children }: SidebarSectionProps): JSX.Element {
  return (
    <section className="cg-side-section">
      <div className="cg-side-section__header">
        <h3 className="cg-side-section__title">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
