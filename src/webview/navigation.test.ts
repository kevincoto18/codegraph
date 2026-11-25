import { describe, expect, it } from 'vitest';

import type { KeyInput, WheelInput } from './navigation';
import {
  KEY_PAN_FAST_FACTOR,
  KEY_PAN_STEP,
  WHEEL_GESTURE_GAP_MS,
  WheelClassifier,
  detectWheelDevice,
  keyCommand,
  wheelPanDelta,
} from './navigation';

/**
 * Builds a wheel input.
 *
 * @param overrides - Fields to set.
 * @returns The input.
 */
function wheel(overrides: Partial<WheelInput>): WheelInput {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

/**
 * Builds a key input.
 *
 * @param key - Key name.
 * @param overrides - Modifiers.
 * @returns The input.
 */
function key(name: string, overrides: Partial<KeyInput> = {}): KeyInput {
  return {
    key: name,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  };
}

/** A mouse wheel notch in Chromium on Windows. */
const MOUSE_NOTCH = wheel({ deltaY: 100, wheelDeltaY: -120 });

/** A two-finger touchpad scroll. */
const TOUCHPAD_SCROLL = wheel({ deltaY: 4, wheelDeltaY: -12 });

describe('detectWheelDevice', () => {
  it('recognizes mouse wheel notches', () => {
    expect(detectWheelDevice(MOUSE_NOTCH)).toBe('mouse');
    expect(detectWheelDevice(wheel({ deltaY: -125 }))).toBe('mouse');
    expect(detectWheelDevice(wheel({ deltaY: 3, deltaMode: 1 }))).toBe('mouse');
  });

  it('recognizes touchpads', () => {
    expect(detectWheelDevice(TOUCHPAD_SCROLL)).toBe('touchpad');
    expect(detectWheelDevice(wheel({ deltaX: 6, deltaY: 1 }))).toBe('touchpad');
    expect(detectWheelDevice(wheel({ deltaY: 2.5 }))).toBe('touchpad');
    expect(detectWheelDevice(wheel({ deltaY: 120, wheelDeltaY: -360 }))).toBe('touchpad');
  });

  it('keeps Shift + wheel on a mouse a mouse', () => {
    expect(detectWheelDevice(wheel({ deltaX: 100, shiftKey: true }))).toBe('mouse');
  });
});

describe('WheelClassifier', () => {
  it('zooms with a mouse and pans with a touchpad in auto mode', () => {
    expect(new WheelClassifier().classify(MOUSE_NOTCH, 'auto', 0)).toBe('zoom');
    expect(new WheelClassifier().classify(TOUCHPAD_SCROLL, 'auto', 0)).toBe('pan');
  });

  it('always zooms on pinch and Ctrl + wheel', () => {
    const pinch = wheel({ deltaY: 3.2, ctrlKey: true });
    expect(new WheelClassifier().classify(pinch, 'auto', 0)).toBe('zoom');
    expect(new WheelClassifier().classify(pinch, 'pan', 0)).toBe('zoom');
  });

  it('pans with Shift + wheel in every mode', () => {
    const shifted = wheel({ deltaY: 100, shiftKey: true });
    expect(new WheelClassifier().classify(shifted, 'zoom', 0)).toBe('pan');
    expect(new WheelClassifier().classify(shifted, 'auto', 0)).toBe('pan');
  });

  it('follows the pan and zoom settings', () => {
    expect(new WheelClassifier().classify(MOUSE_NOTCH, 'pan', 0)).toBe('pan');
    expect(new WheelClassifier().classify(TOUCHPAD_SCROLL, 'zoom', 0)).toBe('zoom');
  });

  it('keeps the device for the whole gesture and detects again after a pause', () => {
    const classifier = new WheelClassifier();
    expect(classifier.classify(TOUCHPAD_SCROLL, 'auto', 0)).toBe('pan');
    // A large, whole delta in the middle of a touchpad gesture still pans.
    expect(classifier.classify(wheel({ deltaY: 100 }), 'auto', 16)).toBe('pan');
    expect(classifier.classify(MOUSE_NOTCH, 'auto', 16 + WHEEL_GESTURE_GAP_MS + 1)).toBe('zoom');
  });
});

describe('wheelPanDelta', () => {
  it('moves the content against the scroll direction', () => {
    expect(wheelPanDelta(wheel({ deltaX: 10, deltaY: -20 }))).toEqual({ dx: -10, dy: 20 });
  });

  it('scales line and page deltas to pixels', () => {
    expect(wheelPanDelta(wheel({ deltaY: 3, deltaMode: 1 }))).toEqual({ dx: -0, dy: -48 });
    expect(wheelPanDelta(wheel({ deltaY: 1, deltaMode: 2 }))).toEqual({ dx: -0, dy: -800 });
  });

  it('turns Shift + vertical wheel into horizontal movement', () => {
    expect(wheelPanDelta(wheel({ deltaY: 100, shiftKey: true }))).toEqual({ dx: -100, dy: 0 });
    expect(wheelPanDelta(wheel({ deltaX: 100, shiftKey: true }))).toEqual({ dx: -100, dy: -0 });
  });
});

describe('keyCommand', () => {
  it('pans with the arrows, faster with Shift', () => {
    expect(keyCommand(key('ArrowLeft'))).toEqual({ type: 'pan', dx: KEY_PAN_STEP, dy: 0 });
    expect(keyCommand(key('ArrowRight'))).toEqual({ type: 'pan', dx: -KEY_PAN_STEP, dy: 0 });
    expect(keyCommand(key('ArrowUp'))).toEqual({ type: 'pan', dx: 0, dy: KEY_PAN_STEP });
    expect(keyCommand(key('ArrowDown', { shiftKey: true }))).toEqual({
      type: 'pan',
      dx: 0,
      dy: -KEY_PAN_STEP * KEY_PAN_FAST_FACTOR,
    });
  });

  it('zooms with + and - and fits with 0', () => {
    expect(keyCommand(key('+'))).toEqual({ type: 'zoomIn' });
    expect(keyCommand(key('='))).toEqual({ type: 'zoomIn' });
    expect(keyCommand(key('-'))).toEqual({ type: 'zoomOut' });
    expect(keyCommand(key('0'))).toEqual({ type: 'fit' });
  });

  it('leaves other keys and shortcuts with Ctrl, Cmd or Alt alone', () => {
    expect(keyCommand(key('a'))).toBeNull();
    expect(keyCommand(key('ArrowLeft', { ctrlKey: true }))).toBeNull();
    expect(keyCommand(key('0', { metaKey: true }))).toBeNull();
    expect(keyCommand(key('+', { altKey: true }))).toBeNull();
  });
});
