import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@xyflow/react/dist/style.css';
import './styles.css';

import { App } from './App';

/** DOM id of the element the React app mounts into. */
const ROOT_ELEMENT_ID = 'root';

/**
 * Mounts the React application into the webview document.
 *
 * @throws Error if the root element is missing from `index.html`.
 */
function mount(): void {
  const container = document.getElementById(ROOT_ELEMENT_ID);
  if (container === null) {
    throw new Error(`Root element "#${ROOT_ELEMENT_ID}" not found.`);
  }
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

mount();
