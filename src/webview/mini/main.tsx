import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './mini.css';

import { MiniApp } from './MiniApp';

/**
 * Mounts the side view into the webview document.
 *
 * @throws Error if the root element is missing from `mini.html`.
 */
function mount(): void {
  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('Root element "#root" not found.');
  }
  createRoot(container).render(
    <StrictMode>
      <MiniApp />
    </StrictMode>,
  );
}

mount();
