import { describe, expect, it } from 'vitest';

import { decodeDataUrl, exportFilters } from './exportFiles';

describe('decodeDataUrl', () => {
  it('decodes base64 data URLs', () => {
    expect([...(decodeDataUrl('data:image/png;base64,AAEC') ?? [])]).toEqual([0, 1, 2]);
  });

  it('decodes percent-encoded data URLs', () => {
    const bytes = decodeDataUrl('data:image/svg+xml;charset=utf-8,%3Csvg%3E%C3%A9%3C%2Fsvg%3E');
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe('<svg>é</svg>');
  });

  it('rejects other texts and broken encodings', () => {
    expect(decodeDataUrl('flowchart LR')).toBeNull();
    expect(decodeDataUrl('data:text/plain,%E0%A4%A')).toBeNull();
  });
});

describe('exportFilters', () => {
  it('offers the extension of each format', () => {
    expect(exportFilters('png')).toEqual({ 'PNG image': ['png'] });
    expect(exportFilters('mermaid')).toEqual({ 'Mermaid diagram': ['mmd', 'md'] });
  });
});
