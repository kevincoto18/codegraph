/**
 * Minimal HTTP server that hosts the built webview with a fake VS Code API,
 * so the real UI can be driven by a headless browser.
 */
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/** Data served to the page for the current scenario. */
export interface HarnessData {
  /** JSON array of the `graph/init` messages that transport the snapshot. */
  initMessagesJson: string;
}

/** CSS variables approximating VS Code's default dark theme. */
const THEME_VARIABLES = `
  --vscode-font-family: system-ui, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: monospace; --vscode-editor-background: #1f1f1f;
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-errorForeground: #f85149; --vscode-panel-border: #2b2b2b;
  --vscode-sideBar-background: #181818; --vscode-editorWidget-background: #202020;
  --vscode-list-hoverBackground: #2a2d2e; --vscode-focusBorder: #0078d4;
  --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc;
  --vscode-input-background: #313131; --vscode-input-foreground: #cccccc;
  --vscode-editorLineNumber-foreground: #6e7681; --vscode-charts-blue: #3794ff;
  --vscode-charts-purple: #b180d7; --vscode-charts-green: #89d185; --vscode-charts-yellow: #cca700;`;

/** Page script: fake `acquireVsCodeApi` plus in-page measurement helpers. */
const HARNESS_SCRIPT = `
  window.__sent = [];
  window.__t = {};
  const params = new URLSearchParams(location.search);
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      window.__sent.push(message);
      if (message.type !== 'ready' || window.__initDone) return;
      window.__initDone = true;
      fetch('/init.json').then((r) => r.json()).then(async (initMessages) => {
        window.postMessage({ type: 'options', options: { collapseMode: params.get('collapse') || 'always' } }, '*');
        window.__t.initPostedAt = performance.now();
        for (const message of initMessages) window.postMessage(message, '*');
        while (!document.querySelector('.react-flow__node-file')) await frame();
        await frame();
        window.__t.firstPaint = performance.now() - window.__t.initPostedAt;
      });
    },
  });
  const predicates = {
    collapsed: () => !document.querySelector('.react-flow__node-function'),
    expanded: () => !!document.querySelector('.react-flow__node-function'),
    any: () => true,
  };
  window.__clickAndWait = async (label, predicate, timeoutMs) => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    const startedAt = performance.now();
    button.click();
    while (!predicates[predicate]()) {
      if (performance.now() - startedAt > timeoutMs) return -1;
      await frame();
    }
    await frame(); await frame();
    return performance.now() - startedAt;
  };
  window.__fps = (durationMs) => new Promise((resolve) => {
    let frames = 0;
    const startedAt = performance.now();
    const tick = () => {
      frames += 1;
      const elapsed = performance.now() - startedAt;
      if (elapsed < durationMs) requestAnimationFrame(tick); else resolve((frames * 1000) / elapsed);
    };
    requestAnimationFrame(tick);
  });
  window.__patchLatency = async (patch, expectedText, timeoutMs) => {
    const startedAt = performance.now();
    window.postMessage({ type: 'graph/patch', patch }, '*');
    const status = () => document.querySelector('.cg-toolbar__status')?.textContent ?? '';
    while (!status().includes(expectedText)) {
      if (performance.now() - startedAt > timeoutMs) return -1;
      await frame();
    }
    await frame();
    return performance.now() - startedAt;
  };
  window.__typeLatency = async (text, timeoutMs) => {
    const input = document.querySelector('.cg-search__input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const latencies = [];
    for (let i = 1; i <= text.length; i += 1) {
      const before = document.querySelector('.cg-search__count')?.textContent;
      const startedAt = performance.now();
      setter.call(input, text.slice(0, i));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      while (document.querySelector('.cg-search__count')?.textContent === before) {
        if (performance.now() - startedAt > timeoutMs) break;
        await frame();
      }
      await frame();
      latencies.push(performance.now() - startedAt);
    }
    return latencies;
  };
`;

/**
 * Builds the harness HTML page.
 *
 * @returns The HTML document.
 */
function harnessHtml(): string {
  return `<!doctype html><html><head><meta charset="UTF-8" /><style>html {${THEME_VARIABLES} }</style>
<link rel="stylesheet" href="/index.css" /><script>${HARNESS_SCRIPT}</script></head>
<body><div id="root"></div><script type="module" src="/index.js"></script></body></html>`;
}

/**
 * Starts the harness server on a random local port.
 *
 * @param webviewDist - Folder of the built webview (`dist/webview`).
 * @param data - Mutable scenario data (read on every request).
 * @returns The server and its base URL.
 */
export async function startHarness(
  webviewDist: string,
  data: HarnessData,
): Promise<{ server: Server; url: string }> {
  const [script, style] = await Promise.all([
    readFile(join(webviewDist, 'index.js'), 'utf8'),
    readFile(join(webviewDist, 'index.css'), 'utf8'),
  ]);
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const routes: Record<string, [string, string]> = {
      '/': ['text/html', harnessHtml()],
      '/index.js': ['text/javascript', script],
      '/index.css': ['text/css', style],
      '/init.json': ['application/json', data.initMessagesJson],
    };
    const route = path === undefined ? undefined : routes[path];
    if (route === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { 'Content-Type': route[0], 'Cache-Control': 'no-store' })
      .end(route[1]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}/` };
}
