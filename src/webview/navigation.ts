/**
 * How the canvas reacts to the mouse wheel, the touchpad and the keyboard.
 * Pure, so the rules are unit-tested; `useCanvasNavigation` applies them.
 */
import type { ScrollBehavior } from '../shared';

/** Fields of a `wheel` event used to tell a mouse wheel from a touchpad. */
export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** Non-standard `wheelDeltaY` (Chromium), when available. */
  readonly wheelDeltaY?: number | undefined;
}

/** What a wheel event does: zoom (left to React Flow) or pan the canvas. */
export type WheelAction = 'zoom' | 'pan';

/** Device that produced a wheel event. */
export type WheelDevice = 'mouse' | 'touchpad';

/** Wheel events closer than this belong to the same gesture (same device). */
export const WHEEL_GESTURE_GAP_MS = 300;

/** Mouse wheel notches are at least this many pixels in Chromium. */
const MOUSE_NOTCH_MIN_PX = 50;

/** Pixels per line when a wheel event counts lines (`deltaMode` 1). */
const LINE_HEIGHT_PX = 16;

/** Pixels per page when a wheel event counts pages (`deltaMode` 2). */
const PAGE_HEIGHT_PX = 800;

/** Pixels moved by an arrow key. */
export const KEY_PAN_STEP = 80;

/** Multiplier of {@link KEY_PAN_STEP} while Shift is held. */
export const KEY_PAN_FAST_FACTOR = 3;

/**
 * Guesses which device produced a wheel event. A mouse wheel moves in large
 * whole steps along one axis; a touchpad sends small, often fractional
 * deltas on both axes.
 *
 * @param input - Wheel event fields.
 * @returns The likely device.
 */
export function detectWheelDevice(input: WheelInput): WheelDevice {
  if (input.deltaMode !== 0) {
    return 'mouse';
  }
  if (input.deltaX !== 0 && !input.shiftKey) {
    return 'touchpad';
  }
  if (input.wheelDeltaY !== undefined && input.wheelDeltaY !== 0) {
    // Chromium reports touchpads with wheelDeltaY = -3 × deltaY.
    if (input.wheelDeltaY === -3 * input.deltaY) {
      return 'touchpad';
    }
  }
  // Shift + wheel may arrive as a horizontal delta.
  const delta = input.shiftKey && input.deltaY === 0 ? input.deltaX : input.deltaY;
  if (!Number.isInteger(delta) || Math.abs(delta) < MOUSE_NOTCH_MIN_PX) {
    return 'touchpad';
  }
  return 'mouse';
}

/**
 * Remembers the device of the current gesture, so a gesture is never split
 * between zooming and panning when one of its events looks ambiguous.
 */
export class WheelClassifier {
  private device: WheelDevice = 'mouse';
  private lastEventAt = Number.NEGATIVE_INFINITY;

  /**
   * Decides what a wheel event does.
   *
   * @param input - Wheel event fields.
   * @param behavior - The `codegraph.scrollBehavior` setting.
   * @param now - Event time, in milliseconds.
   * @returns `zoom` (React Flow handles it) or `pan`.
   */
  public classify(input: WheelInput, behavior: ScrollBehavior, now: number): WheelAction {
    if (now - this.lastEventAt > WHEEL_GESTURE_GAP_MS) {
      this.device = detectWheelDevice(input);
    }
    this.lastEventAt = now;
    // Ctrl + wheel is a pinch on touchpads and a zoom request on mice.
    if (input.ctrlKey || input.metaKey) {
      return 'zoom';
    }
    if (input.shiftKey || behavior === 'pan') {
      return 'pan';
    }
    if (behavior === 'zoom') {
      return 'zoom';
    }
    return this.device === 'touchpad' ? 'pan' : 'zoom';
  }
}

/**
 * Converts a wheel event into a canvas movement, in screen pixels. Shift
 * turns a vertical wheel into horizontal movement.
 *
 * @param input - Wheel event fields.
 * @returns How far the content moves (positive: right / down).
 */
export function wheelPanDelta(input: WheelInput): { readonly dx: number; readonly dy: number } {
  const scale = input.deltaMode === 1 ? LINE_HEIGHT_PX : input.deltaMode === 2 ? PAGE_HEIGHT_PX : 1;
  if (input.shiftKey && input.deltaX === 0) {
    return { dx: -input.deltaY * scale, dy: 0 };
  }
  return { dx: -input.deltaX * scale, dy: -input.deltaY * scale };
}

/** Canvas command bound to a key. */
export type KeyCommand =
  | { readonly type: 'pan'; readonly dx: number; readonly dy: number }
  | { readonly type: 'zoomIn' }
  | { readonly type: 'zoomOut' }
  | { readonly type: 'fit' };

/** Fields of a `keydown` event used by {@link keyCommand}. */
export interface KeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * Finds the canvas command of a key: arrows pan (faster with Shift), `+` and
 * `-` zoom, `0` fits the graph. Keys with Ctrl, Cmd or Alt are left to other
 * shortcuts.
 *
 * @param input - Keyboard event fields.
 * @returns The command, or `null` when the key is not a canvas key.
 */
export function keyCommand(input: KeyInput): KeyCommand | null {
  if (input.ctrlKey || input.metaKey || input.altKey) {
    return null;
  }
  const step = KEY_PAN_STEP * (input.shiftKey ? KEY_PAN_FAST_FACTOR : 1);
  switch (input.key) {
    case 'ArrowLeft':
      return { type: 'pan', dx: step, dy: 0 };
    case 'ArrowRight':
      return { type: 'pan', dx: -step, dy: 0 };
    case 'ArrowUp':
      return { type: 'pan', dx: 0, dy: step };
    case 'ArrowDown':
      return { type: 'pan', dx: 0, dy: -step };
    case '+':
    case '=':
      return { type: 'zoomIn' };
    case '-':
    case '_':
      return { type: 'zoomOut' };
    case '0':
      return { type: 'fit' };
    default:
      return null;
  }
}

/**
 * Tells whether keys typed on an element belong to it (text fields, menus),
 * so canvas shortcuts must not react.
 *
 * @param target - Event target.
 * @returns `true` for editable or interactive elements.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="menu"]') !== null
  );
}
