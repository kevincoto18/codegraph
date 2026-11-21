import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, buildWebviewHtml, createNonce } from './webviewHtml';

describe('createNonce', () => {
  it('creates distinct 128-bit base64 tokens', () => {
    const first = createNonce();
    expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(first);
  });
});

describe('buildContentSecurityPolicy', () => {
  it('blocks everything by default and only allows nonce scripts', () => {
    const csp = buildContentSecurityPolicy('vscode-resource:', 'abc');
    expect(csp).toBe(
      "default-src 'none'; img-src vscode-resource: data:; style-src vscode-resource: 'unsafe-inline'; font-src vscode-resource:; script-src 'nonce-abc'",
    );
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });
});

describe('buildWebviewHtml', () => {
  const html = buildWebviewHtml({
    scriptUri: 'https://file+.vscode-resource/dist/webview/index.js',
    styleUri: 'https://file+.vscode-resource/dist/webview/index.css',
    cspSource: 'https://*.vscode-cdn.net',
    nonce: 'n0nce+/=',
  });

  it('embeds the CSP, stylesheet, mount point and nonce-tagged module script', () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("script-src 'nonce-n0nce+/='");
    expect(html).toContain(
      '<link rel="stylesheet" href="https://file+.vscode-resource/dist/webview/index.css" />',
    );
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(
      '<script type="module" nonce="n0nce+/=" src="https://file+.vscode-resource/dist/webview/index.js"></script>',
    );
  });

  it('escapes attribute values', () => {
    const unsafe = buildWebviewHtml({
      scriptUri: '"><x',
      styleUri: 'a&b',
      cspSource: 'c',
      nonce: 'n',
    });
    expect(unsafe).toContain('src="&quot;&gt;&lt;x"');
    expect(unsafe).toContain('href="a&amp;b"');
  });
});
