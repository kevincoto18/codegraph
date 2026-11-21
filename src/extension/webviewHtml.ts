/**
 * Builds the HTML document loaded by the CodeGraph webview.
 *
 * @remarks Pure (no VS Code API) so the Content Security Policy can be tested.
 */
import { randomBytes } from 'node:crypto';

/** Inputs required to render the webview document. */
export interface WebviewHtmlOptions {
  /** Webview URI of the bundled script (`dist/webview/index.js`). */
  readonly scriptUri: string;
  /** Webview URI of the bundled stylesheet (`dist/webview/index.css`). */
  readonly styleUri: string;
  /** `webview.cspSource` of the panel. */
  readonly cspSource: string;
  /** Single-use token that authorizes the bundled script. */
  readonly nonce: string;
}

/** Number of random bytes used for a nonce (128 bits). */
const NONCE_BYTES = 16;

/**
 * Generates a cryptographically random nonce for the script CSP.
 *
 * @returns A base64 token.
 */
export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64');
}

/**
 * Escapes a value for safe use inside a double-quoted HTML attribute.
 *
 * @param value - Raw attribute value.
 * @returns The escaped value.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Builds the Content Security Policy of the webview.
 *
 * @remarks Scripts are restricted to the nonce. Inline styles are allowed
 * because React Flow positions nodes with inline `style` attributes.
 *
 * @param cspSource - `webview.cspSource` of the panel.
 * @param nonce - Script nonce.
 * @returns The policy string.
 */
export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

/**
 * Renders the complete webview HTML document.
 *
 * @param options - Resource URIs, CSP source and nonce.
 * @returns The HTML document.
 */
export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const csp = escapeAttribute(buildContentSecurityPolicy(options.cspSource, options.nonce));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${escapeAttribute(options.styleUri)}" />
    <title>CodeGraph</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${escapeAttribute(options.nonce)}" src="${escapeAttribute(options.scriptUri)}"></script>
  </body>
</html>`;
}
