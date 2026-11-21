import { describe, expect, it } from 'vitest';

import { formatFileCount } from './FolderNode';

describe('formatFileCount', () => {
  it.each([
    [1, '1 file'],
    [0, '0 files'],
    [42, '42 files'],
  ])('formats %i as "%s"', (count, expected) => {
    expect(formatFileCount(count)).toBe(expected);
  });
});
