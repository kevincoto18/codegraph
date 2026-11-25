import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import {
  countMermaidNodes,
  exportFileName,
  selectFiles,
  subgraphOfFiles,
  toMermaid,
} from './exportGraph';
import { callEdge, fileNode, functionNode } from './testFixtures';

const SNAPSHOT: GraphSnapshot = {
  version: 3,
  nodes: [
    fileNode('index.ts', ['index.ts#main']),
    functionNode('index.ts', 'main'),
    fileNode('src/a.ts', ['src/a.ts#run', 'src/a.ts#step']),
    functionNode('src/a.ts', 'run'),
    functionNode('src/a.ts', 'step'),
    fileNode('src/lib/b.ts', ['src/lib/b.ts#"quoted"']),
    functionNode('src/lib/b.ts', '"quoted"'),
  ],
  edges: [
    { id: 'i1', kind: 'import', source: 'index.ts', target: 'src/a.ts' },
    callEdge('index.ts#main', 'src/a.ts#run'),
    callEdge('index.ts#main', 'src/a.ts#step'),
    callEdge('src/a.ts#run', 'src/lib/b.ts#"quoted"'),
    callEdge('src/a.ts#run', 'src/a.ts#step'),
  ],
};

describe('selectFiles and subgraphOfFiles', () => {
  it('selects files and whole folders', () => {
    expect([...selectFiles(SNAPSHOT, ['src'])].sort()).toEqual(['src/a.ts', 'src/lib/b.ts']);
    expect([...selectFiles(SNAPSHOT, ['index.ts', 'src/lib'])].sort()).toEqual([
      'index.ts',
      'src/lib/b.ts',
    ]);
    expect(selectFiles(SNAPSHOT, ['sr']).size).toBe(0);
  });

  it('keeps the selected files, their functions and the edges between them', () => {
    const sub = subgraphOfFiles(SNAPSHOT, new Set(['src/a.ts', 'src/lib/b.ts']));
    expect(sub.nodes.map((node) => node.id)).toEqual([
      'src/a.ts',
      'src/a.ts#run',
      'src/a.ts#step',
      'src/lib/b.ts',
      'src/lib/b.ts#"quoted"',
    ]);
    expect(sub.edges).toHaveLength(2);
  });
});

describe('toMermaid', () => {
  it('draws files by folder, imports dashed and calls merged between files', () => {
    expect(toMermaid(SNAPSHOT, { level: 'files', imports: true, calls: true })).toBe(
      [
        'flowchart LR',
        '  n0["index.ts"]',
        '  subgraph g0["src"]',
        '    n1["src/a.ts"]',
        '  end',
        '  subgraph g1["src/lib"]',
        '    n2["src/lib/b.ts"]',
        '  end',
        '  n0 -.-> n1',
        '  n0 -->|"×2"| n1',
        '  n1 --> n2',
        '',
      ].join('\n'),
    );
  });

  it('draws functions by file, escaping quotes, without imports', () => {
    const text = toMermaid(SNAPSHOT, { level: 'functions', imports: true, calls: true });
    expect(text).toContain('subgraph g1["src/a.ts"]');
    expect(text).toContain('n3("#quot;quoted#quot;")');
    expect(text).toContain('n1 --> n2');
    expect(text).not.toContain('-.->');
  });

  it('leaves out edge kinds that are turned off', () => {
    const text = toMermaid(SNAPSHOT, { level: 'files', imports: false, calls: false });
    expect(text).not.toContain('-->');
    expect(text).not.toContain('-.->');
  });
});

describe('countMermaidNodes and exportFileName', () => {
  it('counts the drawn nodes and names the file', () => {
    expect(countMermaidNodes(SNAPSHOT, 'files')).toBe(3);
    expect(countMermaidNodes(SNAPSHOT, 'functions')).toBe(4);
    expect(exportFileName('png', 'selected')).toBe('codegraph-selection.png');
    expect(exportFileName('mermaid', 'all')).toBe('codegraph-graph.mmd');
  });
});
