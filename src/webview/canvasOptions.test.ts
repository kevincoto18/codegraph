import { describe, expect, it } from 'vitest';

import {
  isLowDetailZoom,
  LOW_DETAIL_ZOOM,
  MINIMAP_AUTO_MAX_NODES,
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
