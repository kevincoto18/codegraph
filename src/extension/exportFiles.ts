/**
 * Decoding of the exports sent by the webview. Pure, so it is unit-tested.
 */

/**
 * Decodes a `data:` URL (base64 or percent-encoded) into bytes.
 *
 * @param url - Data URL, e.g. `data:image/png;base64,iVBOR…`.
 * @returns The bytes, or `null` when the URL is not a data URL.
 */
export function decodeDataUrl(url: string): Uint8Array | null {
  const match = /^data:([^,]*?),(.*)$/s.exec(url);
  if (match === null) {
    return null;
  }
  const [, header = '', payload = ''] = match;
  if (header.split(';').includes('base64')) {
    return new Uint8Array(Buffer.from(payload, 'base64'));
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

/**
 * Save dialog filters of an export format.
 *
 * @param format - Export format.
 * @returns Filter name and extensions.
 */
export function exportFilters(format: 'png' | 'svg' | 'mermaid'): Record<string, string[]> {
  switch (format) {
    case 'png':
      return { 'PNG image': ['png'] };
    case 'svg':
      return { 'SVG image': ['svg'] };
    case 'mermaid':
      return { 'Mermaid diagram': ['mmd', 'md'] };
  }
}
