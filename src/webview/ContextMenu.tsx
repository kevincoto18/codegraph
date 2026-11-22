import type { JSX } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ContextMenuAction, ContextMenuState } from './contextMenu';

/** Props of {@link ContextMenu}. */
interface ContextMenuProps {
  /** Position and entries of the menu. */
  readonly menu: ContextMenuState;
  /** Runs the chosen entry's action (the menu closes afterwards). */
  readonly onSelect: (action: ContextMenuAction) => void;
  /** Closes the menu without choosing anything. */
  readonly onClose: () => void;
}

/** Gap kept between the menu and the window edges, in pixels. */
const EDGE_MARGIN = 4;

/**
 * Floating context menu of the canvas. It stays inside the window and
 * closes on Escape, on a click outside it, on scroll and on window blur.
 *
 * @param props - Menu state and callbacks.
 * @returns The menu element.
 */
export function ContextMenu({ menu, onSelect, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });

  // Keep the menu inside the window once its size is known.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    // Measuring the DOM is the only way to know the rendered size.
    setPosition({
      left: Math.max(EDGE_MARGIN, Math.min(menu.x, window.innerWidth - width - EDGE_MARGIN)),
      top: Math.max(EDGE_MARGIN, Math.min(menu.y, window.innerHeight - height - EDGE_MARGIN)),
    });
  }, [menu.x, menu.y]);

  useEffect(() => {
    /**
     * Closes the menu when the pointer goes down outside it.
     *
     * @param event - Pointer event.
     */
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target) !== true) {
        onClose();
      }
    };
    /**
     * Closes the menu on Escape.
     *
     * @param event - Keyboard event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="cg-menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      {menu.items.map((item) => (
        <div key={item.key}>
          {item.separatorBefore === true && <div className="cg-menu__separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="cg-menu__item"
            onClick={() => {
              onSelect(item.action);
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
