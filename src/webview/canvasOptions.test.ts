import { describe, expect, it } from 'vitest';

import {
  LOW_DETAIL_MAX_EDGES,
  computeFitViewport,
  isLowDetailZoom,
  LOW_DETAIL_ZOOM,
  MINIMAP_AUTO_MAX_NODES,
  shouldHideEdges,
  shouldShowMinimap,
} from './canvasOptions';

describe('isLowDetailZoom', () => {
  it('switches to low detail below the threshold', () => {
    expect(isLowDetailZoom(LOW_DETAIL_ZOOM - 0.01)).toBe(true);
    expect(isLowDetailZoom(LOW_DETAIL_ZOOM)).toBe(false);
    expect(isLowDetailZoom(1)).toBe(false);
  });
});

describe('shouldShowMinimap', () => {
  it('hides the minimap automatically on large graphs', () => {
    expect(shouldShowMinimap('auto', MINIMAP_AUTO_MAX_NODES)).toBe(true);
    expect(shouldShowMinimap('auto', MINIMAP_AUTO_MAX_NODES + 1)).toBe(false);
  });

  it('honours an explicit choice', () => {
    expect(shouldShowMinimap('on', 1_000_000)).toBe(true);
    expect(shouldShowMinimap('off', 1)).toBe(false);
  });
});

describe('shouldHideEdges', () => {
  it('hides only large edge sets while zoomed out', () => {
    expect(shouldHideEdges(true, LOW_DETAIL_MAX_EDGES + 1)).toBe(true);
    expect(shouldHideEdges(true, LOW_DETAIL_MAX_EDGES)).toBe(false);
    expect(shouldHideEdges(false, 1_000_000)).toBe(false);
  });
});

describe('computeFitViewport', () => {
  it('fits top-level nodes and ignores children', () => {
    const viewport = computeFitViewport(
      [
        {
          id: 'a',
          type: 'file',
          position: { x: 0, y: 0 },
          width: 100,
          height: 100,
          data: { label: 'a', filePath: 'a', line: 1, functionCount: 0, collapsed: true },
        },
        {
          id: 'b',
          type: 'file',
          position: { x: 900, y: 0 },
          width: 100,
          height: 100,
          data: { label: 'b', filePath: 'b', line: 1, functionCount: 0, collapsed: true },
        },
        {
          id: 'c',
          type: 'function',
          parentId: 'a',
          position: { x: 5000, y: 5000 },
          data: { label: 'c', filePath: 'a', line: 1, functionKind: 'function', exported: false },
        },
      ],
      1100,
      500,
    );
    expect(viewport.zoom).toBeCloseTo(1);
    expect(viewport.x).toBeCloseTo(50);
  });

  it('returns the identity viewport for an empty graph', () => {
    expect(computeFitViewport([], 800, 600)).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
