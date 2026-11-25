/**
 * Side view of the Explorer: a small graph of what the active file (or the
 * function under the cursor) uses and what uses it.
 */
import type { JSX } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { MiniEmptyReason, MiniGraph, MiniHostToView, MiniMode, MiniNode } from '../../shared';
import { Icon } from '../icons';
import { postMini, subscribeMini } from './miniApi';
import type { MiniBox } from './miniLayout';
import { EMPTY_INCOMING_ID, layoutMiniGraph } from './miniLayout';

/** Size of the drawing area. */
interface Size {
  readonly width: number;
  readonly height: number;
}

/** Texts of each empty state. */
const EMPTY_TEXTS: Readonly<Record<MiniEmptyReason, { title: string; hint: string }>> = {
  'no-folder': { title: 'No folder open', hint: 'Open a folder to see how its code connects.' },
  'no-editor': {
    title: 'Open a file',
    hint: 'See what it uses and what uses it, right here.',
  },
  analyzing: { title: 'Analyzing workspace…', hint: 'This only takes a moment the first time.' },
  'not-in-graph': {
    title: 'Not in the graph',
    hint: 'This file is excluded or its language is not supported.',
  },
  'no-function': {
    title: 'Place the cursor in a function',
    hint: 'Its callers and callees will show up here.',
  },
  error: {
    title: 'Could not analyze the workspace',
    hint: 'Check the CodeGraph output for details.',
  },
};

/**
 * Estimates the height of the center card before it is measured.
 *
 * @param graph - Mini graph.
 * @returns Height in pixels.
 */
function estimateCenterHeight(graph: MiniGraph): number {
  if (graph.mode === 'files') {
    return 58 + (graph.members.length > 0 ? 12 + graph.members.length * 24 : 0);
  }
  return 58 + (graph.details === null ? 0 : 70);
}

/**
 * Tracks the size of an element.
 *
 * @returns A ref to attach and the current size.
 */
function useElementSize(): [React.RefObject<HTMLDivElement | null>, Size] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, size];
}

/** Props of {@link NeighborCard}. */
interface NeighborCardProps {
  readonly node: MiniNode;
  readonly box: MiniBox;
  readonly side: 'in' | 'out';
  readonly dimmed: boolean;
  readonly onHover: (id: string | null) => void;
}

/**
 * A neighbor: click opens it in the editor (the view then follows it).
 *
 * @param props - Component props.
 * @returns The card.
 */
function NeighborCard({ node, box, side, dimmed, onHover }: NeighborCardProps): JSX.Element {
  const relation = node.relation ?? 'call';
  return (
    <div
      className={`mini-node mini-node--${relation} mini-node--${side}${dimmed ? ' is-dimmed' : ''}`}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      role="button"
      tabIndex={0}
      title={`${node.detail === '' ? node.label : `${node.detail}/${node.label}`}\nClick to open · ${relationText(relation)}`}
      onClick={() => {
        postMini({ type: 'mini/open', nodeId: node.id });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          postMini({ type: 'mini/open', nodeId: node.id });
        }
      }}
      onMouseEnter={() => {
        onHover(node.id);
      }}
      onMouseLeave={() => {
        onHover(null);
      }}
    >
      <span className="mini-node__text">
        <span className="mini-node__label">{node.label}</span>
        {node.detail !== '' && <span className="mini-node__detail">{node.detail}</span>}
      </span>
      {node.changed === true && <span className="mini-changed" title="Changed in the review" />}
      {(node.weight ?? 0) > 1 && <span className="mini-node__weight">×{node.weight}</span>}
    </div>
  );
}

/**
 * Describes a relation for tooltips.
 *
 * @param relation - Relation with the center.
 * @returns Readable text.
 */
function relationText(relation: string): string {
  return relation === 'both' ? 'imports and calls' : relation === 'import' ? 'imports' : 'calls';
}

/** Props of {@link CenterCard}. */
interface CenterCardProps {
  readonly graph: MiniGraph;
  readonly box: MiniBox;
  readonly cardRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * The file or function under the cursor, with its functions or signature.
 *
 * @param props - Component props.
 * @returns The card.
 */
function CenterCard({ graph, box, cardRef }: CenterCardProps): JSX.Element {
  const { center } = graph;
  return (
    <div
      ref={cardRef}
      className={`mini-center mini-center--${graph.mode}`}
      style={{ left: box.x, top: box.y, width: box.width }}
    >
      <button
        type="button"
        className="mini-center__header"
        title="Open in editor"
        onClick={() => {
          postMini({ type: 'mini/open', nodeId: center.id });
        }}
      >
        <span className={`mini-glyph mini-glyph--${center.kind}`}>
          {center.kind === 'file' ? '{ }' : 'ƒ'}
        </span>
        <span className="mini-center__titles">
          <span className="mini-center__label">{center.label}</span>
          <span className="mini-center__detail">{center.detail === '' ? '/' : center.detail}</span>
        </span>
        {center.changed === true && <span className="mini-changed-tag">changed</span>}
      </button>
      {graph.mode === 'files' && graph.members.length > 0 && (
        <ul className="mini-members">
          {graph.members.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                className={`mini-member${member.id === graph.activeId ? ' is-active' : ''}`}
                title={`Go to ${member.label} (line ${String(member.line)})`}
                onClick={() => {
                  postMini({ type: 'mini/open', nodeId: member.id });
                }}
              >
                <span className="mini-member__glyph">ƒ</span>
                <span className="mini-member__label">{member.label}</span>
                {member.changed === true && (
                  <span className="mini-changed" title="Changed in the review" />
                )}
                <span className="mini-member__line">{member.line}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {graph.mode === 'functions' && graph.details !== null && (
        <div className="mini-details">
          <code className="mini-details__signature">{graph.details.signature}</code>
          {graph.details.doc !== null && <p className="mini-details__doc">{graph.details.doc}</p>}
        </div>
      )}
    </div>
  );
}

/** Props of {@link GraphDrawing}. */
interface GraphDrawingProps {
  readonly graph: MiniGraph;
  readonly size: Size;
}

/**
 * Draws the center, its neighbors and the curved edges between them.
 *
 * @param props - Component props.
 * @returns The drawing.
 */
function GraphDrawing({ graph, size }: GraphDrawingProps): JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [centerHeight, setCenterHeight] = useState(() => estimateCenterHeight(graph));
  const [hovered, setHovered] = useState<string | null>(null);

  useLayoutEffect(() => {
    const element = cardRef.current;
    if (element === null) {
      return undefined;
    }
    /** Stores the rendered height of the center card. */
    const measure = (): void => {
      setCenterHeight(element.offsetHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [graph]);

  const layout = useMemo(
    () =>
      layoutMiniGraph(
        {
          incoming: graph.incoming.map((node) => node.id),
          outgoing: graph.outgoing.map((node) => node.id),
          hasMoreIncoming: graph.moreIncoming > 0,
          hasMoreOutgoing: graph.moreOutgoing > 0,
          centerHeight,
        },
        size.width,
        size.height,
      ),
    [graph, centerHeight, size.width, size.height],
  );

  const byId = new Map<string, MiniNode>(
    [...graph.incoming, ...graph.outgoing].map((node) => [node.id, node]),
  );
  const isFiles = graph.mode === 'files';
  const inTitle = isFiles ? 'Used by' : 'Called by';
  const outTitle = isFiles ? 'Uses' : 'Calls';
  const vertical = layout.orientation === 'vertical';

  /**
   * Renders one side: neighbors, placeholder and "+N more" row.
   *
   * @param side - Which side.
   * @returns The elements.
   */
  const renderSide = (side: 'in' | 'out'): JSX.Element[] => {
    const boxes = side === 'in' ? layout.incoming : layout.outgoing;
    const more = side === 'in' ? layout.moreIncoming : layout.moreOutgoing;
    const moreCount = side === 'in' ? graph.moreIncoming : graph.moreOutgoing;
    const label = side === 'in' ? layout.incomingLabel : layout.outgoingLabel;
    const total = (side === 'in' ? graph.incoming.length : graph.outgoing.length) + moreCount;
    const align = vertical ? 'center' : side === 'in' ? 'right' : 'left';
    const elements: JSX.Element[] = [
      <div
        key={`label-${side}`}
        className="mini-section"
        style={{ left: label.x, top: label.y, width: label.width, textAlign: align }}
      >
        {side === 'in' ? inTitle : outTitle}
        <span className="mini-section__count">{total}</span>
      </div>,
    ];
    for (const box of boxes) {
      const node = byId.get(box.id);
      if (node === undefined) {
        elements.push(
          <div
            key={box.id}
            className="mini-placeholder"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          >
            {box.id === EMPTY_INCOMING_ID
              ? isFiles
                ? 'Nothing imports it'
                : 'No callers found'
              : isFiles
                ? 'No dependencies'
                : 'Calls nothing'}
          </div>,
        );
      } else {
        elements.push(
          <NeighborCard
            key={box.id}
            node={node}
            box={box}
            side={side}
            dimmed={hovered !== null && hovered !== node.id}
            onHover={setHovered}
          />,
        );
      }
    }
    if (more !== null) {
      elements.push(
        <button
          key={`more-${side}`}
          type="button"
          className="mini-more"
          style={{ left: more.x, top: more.y, width: more.width, height: more.height }}
          title="Show everything in the full graph"
          onClick={() => {
            postMini({ type: 'mini/graph', nodeId: graph.center.id });
          }}
        >
          +{moreCount} more
        </button>,
      );
    }
    return elements;
  };

  return (
    <div className="mini-drawing" style={{ width: layout.width, height: layout.height }}>
      <svg className="mini-edges" width={layout.width} height={layout.height} aria-hidden="true">
        <defs>
          {(['import', 'call', 'both', 'trunk'] as const).map((relation) => (
            <marker
              key={relation}
              id={`mini-arrow-${relation}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" className={`mini-arrow mini-arrow--${relation}`} />
            </marker>
          ))}
        </defs>
        {layout.edges.map((edge) => {
          const relation = edge.trunk ? 'trunk' : (byId.get(edge.id)?.relation ?? 'call');
          const state =
            hovered === null || edge.trunk ? '' : hovered === edge.id ? ' is-active' : ' is-dimmed';
          return (
            <path
              key={`${edge.side}-${edge.id}`}
              d={edge.path}
              className={`mini-edge mini-edge--${relation}${state}`}
              markerEnd={`url(#mini-arrow-${relation})`}
            />
          );
        })}
      </svg>
      {renderSide('in')}
      {renderSide('out')}
      <CenterCard graph={graph} box={layout.center} cardRef={cardRef} />
    </div>
  );
}

/** Props of {@link EmptyState}. */
interface EmptyStateProps {
  readonly reason: MiniEmptyReason;
}

/**
 * Centered message shown when there is nothing to draw.
 *
 * @param props - Component props.
 * @returns The message.
 */
function EmptyState({ reason }: EmptyStateProps): JSX.Element {
  const text = EMPTY_TEXTS[reason];
  return (
    <div className="mini-empty">
      <div className={`mini-empty__icon${reason === 'analyzing' ? ' is-spinning' : ''}`}>
        <Icon name={reason === 'analyzing' ? 'sync' : 'connections'} size={22} />
      </div>
      <div className="mini-empty__title">{text.title}</div>
      <div className="mini-empty__hint">{text.hint}</div>
    </div>
  );
}

/**
 * Root component of the side view.
 *
 * @returns The view.
 */
export function MiniApp(): JSX.Element {
  const [state, setState] = useState<MiniHostToView | null>(null);
  const [ref, size] = useElementSize();

  useEffect(() => {
    const unsubscribe = subscribeMini(setState);
    postMini({ type: 'mini/ready' });
    return unsubscribe;
  }, []);

  const mode: MiniMode =
    state === null ? 'files' : state.type === 'mini/graph' ? state.graph.mode : state.mode;
  const graph = state?.type === 'mini/graph' ? state.graph : null;

  /**
   * Switches between files and functions.
   *
   * @param next - Mode to show.
   */
  const setMode = (next: MiniMode): void => {
    if (next !== mode) {
      postMini({ type: 'mini/mode', mode: next });
    }
  };

  return (
    <div className="mini-app">
      <div className="mini-toolbar">
        <div className="mini-toggle" role="tablist" aria-label="Show">
          {(['files', 'functions'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={`mini-toggle__option${mode === item ? ' is-selected' : ''}`}
              onClick={() => {
                setMode(item);
              }}
            >
              {item === 'files' ? 'Files' : 'Functions'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="mini-icon-button"
          title="Open in the full graph"
          disabled={graph === null}
          onClick={() => {
            if (graph !== null) {
              postMini({ type: 'mini/graph', nodeId: graph.center.id });
            }
          }}
        >
          <Icon name="expand" size={14} />
        </button>
      </div>
      <div className="mini-viewport" ref={ref}>
        {state === null ? (
          <EmptyState reason="analyzing" />
        ) : graph === null ? (
          <EmptyState reason={state.type === 'mini/empty' ? state.reason : 'error'} />
        ) : (
          size.width > 0 && <GraphDrawing key={graph.center.id} graph={graph} size={size} />
        )}
      </div>
      {graph !== null && (
        <div className="mini-footer">
          <span className="mini-legend">
            {graph.mode === 'files' && (
              <span className="mini-legend__item mini-legend__item--import">imports</span>
            )}
            <span className="mini-legend__item mini-legend__item--call">calls</span>
            {graph.mode === 'files' && (
              <span className="mini-legend__item mini-legend__item--both">both</span>
            )}
          </span>
          <span className="mini-footer__hint">Click to open</span>
        </div>
      )}
    </div>
  );
}
