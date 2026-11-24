import { describe, expect, it } from 'vitest';

import {
  VIEW_MARGIN,
  unionBoxes,
  viewportCenteredOn,
  viewportForFocus,
  viewportToFitBoxes,
  viewportToShowBox,
} from './viewportMath';

const PANE = { width: 1000, height: 600 };

describe('unionBoxes', () => {
  it('encloses every box', () => {
    expect(
      unionBoxes([
        { x: 0, y: 10, width: 100, height: 20 },
        { x: 50, y: -5, width: 100, height: 10 },
      ]),
    ).toEqual({ x: 0, y: -5, width: 150, height: 35 });
    expect(unionBoxes([])).toBeNull();
  });
});

describe('viewportToShowBox', () => {
  it('does nothing when the node is visible at a readable zoom', () => {
    expect(
      viewportToShowBox(
        { x: 100, y: 100, width: 200, height: 30 },
        PANE,
        { x: 0, y: 0, zoom: 1 },
        1,
      ),
    ).toBeNull();
  });

  it('zooms in to the target zoom and centers the node', () => {
    const viewport = viewportToShowBox(
      { x: 100, y: 100, width: 200, height: 30 },
      PANE,
      { x: 0, y: 0, zoom: 0.2 },
      1,
    );
    expect(viewport).toEqual(viewportCenteredOn(200, 115, PANE, 1));
  });

  it('never zooms out', () => {
    const viewport = viewportToShowBox(
      { x: 5000, y: 0, width: 200, height: 30 },
      PANE,
      { x: 0, y: 0, zoom: 1.5 },
      1,
    );
    expect(viewport?.zoom).toBe(1.5);
  });

  it('shows the top of a node taller than the pane', () => {
    const viewport = viewportToShowBox(
      { x: 0, y: 0, width: 300, height: 5000 },
      PANE,
      { x: 0, y: 0, zoom: 0.1 },
      0.8,
    );
    // The node's top edge lands just inside the top margin.
    expect(viewport?.y).toBeCloseTo(VIEW_MARGIN);
  });
});

describe('viewportToFitBoxes', () => {
  it('fits small groups of nodes', () => {
    const viewport = viewportToFitBoxes(
      [
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 300, y: 200, width: 100, height: 50 },
      ],
      PANE,
      0.6,
      1,
    );
    expect(viewport?.zoom).toBe(1);
  });

  it('refuses fits that would zoom out too far', () => {
    expect(
      viewportToFitBoxes([{ x: 0, y: 0, width: 10_000, height: 8000 }], PANE, 0.6, 1),
    ).toBeNull();
  });
});

describe('viewportForFocus', () => {
  const focusBox = { x: 0, y: 400, width: 100, height: 20 };

  it('centers the focused node when its neighbors still fit', () => {
    const viewport = viewportForFocus(
      focusBox,
      [{ x: 0, y: 200, width: 100, height: 20 }],
      PANE,
      0.6,
      1,
    );
    expect(viewport).toEqual(viewportCenteredOn(50, 410, PANE, 1));
  });

  it('zooms out to show far neighbors, but not below the minimum', () => {
    const near = viewportForFocus(
      focusBox,
      [{ x: 0, y: 100, width: 100, height: 20 }],
      PANE,
      0.6,
      1,
    );
    expect(near.zoom).toBeGreaterThan(0.6);
    expect(near.zoom).toBeLessThan(1);
    const far = viewportForFocus(
      focusBox,
      [{ x: 0, y: -5000, width: 100, height: 20 }],
      PANE,
      0.6,
      1,
    );
    expect(far).toEqual(viewportCenteredOn(50, 410, PANE, 0.6));
  });
});
