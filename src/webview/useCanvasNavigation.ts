/**
 * Mouse wheel, touchpad and keyboard navigation of the canvas (see
 * `navigation.ts` for the rules). Must be used inside the React Flow provider.
 */
import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';

import type { ScrollBehavior } from '../shared';
import type { WheelInput } from './navigation';
import { WheelClassifier, isTypingTarget, keyCommand, wheelPanDelta } from './navigation';

/** Duration of keyboard pans and zooms, in milliseconds. */
const KEY_ANIMATION_MS = 140;

/** Duration of the "fit the graph" animation, in milliseconds. */
const FIT_ANIMATION_MS = 260;

/** Elements of the canvas that scroll or zoom on their own (sidebar, minimap…). */
const OWN_WHEEL_SELECTOR = '.react-flow__panel, .react-flow__controls';

/**
 * Tells whether a wheel event targets the canvas itself (not the sidebar,
 * the minimap or the controls, which handle the wheel on their own).
 *
 * @param target - Event target.
 * @returns `true` inside the canvas.
 */
function isCanvasWheelTarget(target: Element): boolean {
  return target.closest('.react-flow') !== null && target.closest(OWN_WHEEL_SELECTOR) === null;
}

/** State exposed by {@link useCanvasNavigation}. */
export interface CanvasNavigation {
  /** Whether Space is held: dragging anywhere pans, even over nodes. */
  readonly spacePanning: boolean;
}

/**
 * Reads the fields of a wheel event used by the navigation rules.
 *
 * @param event - Wheel event.
 * @returns The fields.
 */
function toWheelInput(event: WheelEvent): WheelInput {
  const legacy = event as WheelEvent & { readonly wheelDeltaY?: number };
  return {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    wheelDeltaY: legacy.wheelDeltaY,
  };
}

/**
 * Wires the canvas navigation: two-finger scrolling pans (or zooms, per the
 * `codegraph.scrollBehavior` setting), Shift + wheel pans sideways, Space +
 * drag pans anywhere, arrows pan, `+` / `-` zoom and `0` fits the graph.
 *
 * @param scrollBehavior - What the wheel does.
 * @returns Whether Space panning is active.
 */
export function useCanvasNavigation(scrollBehavior: ScrollBehavior): CanvasNavigation {
  const { getViewport, setViewport, zoomIn, zoomOut, fitView } = useReactFlow();
  const [spacePanning, setSpacePanning] = useState(false);
  const classifierRef = useRef(new WheelClassifier());

  // Wheel and touchpad: pans are applied here (batched per frame); zooms are
  // left to React Flow.
  useEffect(() => {
    let pending = { dx: 0, dy: 0 };
    let frame: number | null = null;

    /** Applies the movement accumulated since the last frame. */
    const flush = (): void => {
      frame = null;
      const { x, y, zoom } = getViewport();
      void setViewport({ x: x + pending.dx, y: y + pending.dy, zoom });
      pending = { dx: 0, dy: 0 };
    };

    /**
     * Pans the canvas for touchpad (or configured) scrolling.
     *
     * @param event - Wheel event, seen before React Flow handles it.
     */
    const onWheel = (event: WheelEvent): void => {
      if (!(event.target instanceof Element) || !isCanvasWheelTarget(event.target)) {
        return;
      }
      const input = toWheelInput(event);
      if (classifierRef.current.classify(input, scrollBehavior, event.timeStamp) !== 'pan') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const delta = wheelPanDelta(input);
      pending = { dx: pending.dx + delta.dx, dy: pending.dy + delta.dy };
      frame ??= requestAnimationFrame(flush);
    };

    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true });
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [scrollBehavior, getViewport, setViewport]);

  // Keyboard: arrows, + / -, 0 and Space.
  useEffect(() => {
    /**
     * Runs the canvas command of a key, or starts Space panning.
     *
     * @param event - Keyboard event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTypingTarget(event.target)) {
        return;
      }
      if (event.key === ' ') {
        // Also keeps a focused button from being pressed.
        event.preventDefault();
        setSpacePanning(true);
        return;
      }
      const command = keyCommand(event);
      if (command === null) {
        return;
      }
      event.preventDefault();
      const animation = { duration: KEY_ANIMATION_MS };
      switch (command.type) {
        case 'pan': {
          const { x, y, zoom } = getViewport();
          void setViewport({ x: x + command.dx, y: y + command.dy, zoom }, animation);
          return;
        }
        case 'zoomIn':
          void zoomIn(animation);
          return;
        case 'zoomOut':
          void zoomOut(animation);
          return;
        case 'fit':
          void fitView({ duration: FIT_ANIMATION_MS, padding: 0.1 });
          return;
      }
    };

    /**
     * Ends Space panning.
     *
     * @param event - Keyboard event.
     */
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === ' ') {
        if (!isTypingTarget(event.target)) {
          event.preventDefault();
        }
        setSpacePanning(false);
      }
    };

    /** Ends Space panning when the view loses focus mid-press. */
    const onBlur = (): void => {
      setSpacePanning(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [getViewport, setViewport, zoomIn, zoomOut, fitView]);

  return { spacePanning };
}
