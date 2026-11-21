import { describe, expect, it } from 'vitest';

import { linkGraph } from '../../src/extension/analyzer/linker';
import { parseSource } from '../../src/extension/analyzer/parser';
import { generateProject, relativeSpecifier } from './generateProject';

describe('relativeSpecifier', () => {
  it.each([
    ['a/b/c.ts', 'a/b/d.ts', './d'],
    ['a/b/c.ts', 'a/x/y.js', '../x/y'],
    ['packages/p/src/i.ts', 'shared/hub0.ts', '../../../shared/hub0'],
  ])('from %s to %s is %s', (from, to, expected) => {
    expect(relativeSpecifier(from, to)).toBe(expected);
  });
});

describe('generateProject', () => {
  const project = generateProject({ files: 120, seed: 7 });

  it('generates the requested number of files', () => {
    expect(project.files.size).toBe(120);
    expect(project.hubFiles).toHaveLength(5);
    expect(project.packageRoots).toHaveLength(1);
  });

  it('is deterministic for a given seed', () => {
    const again = generateProject({ files: 120, seed: 7 });
    expect([...again.files.entries()]).toEqual([...project.files.entries()]);
    expect(generateProject({ files: 120, seed: 8 }).files).not.toEqual(project.files);
  });

  it('mixes TS, TSX and JS (ES and CommonJS) files', () => {
    const paths = [...project.files.keys()];
    expect(paths.some((path) => path.endsWith('.ts'))).toBe(true);
    expect(paths.some((path) => path.endsWith('.tsx'))).toBe(true);
    const js = paths
      .filter((path) => path.endsWith('.js'))
      .map((path) => project.files.get(path) ?? '');
    expect(js.some((content) => content.includes('require('))).toBe(true);
    expect(js.some((content) => content.includes('import '))).toBe(true);
  });

  it('produces code the analyzer understands, with cross-file calls into hubs', () => {
    const parsed = [...project.files.entries()].map(([path, content]) =>
      parseSource(path, content),
    );
    const graph = linkGraph(parsed, 1);
    const functions = graph.nodes.filter((node) => node.kind === 'function');
    const calls = graph.edges.filter((edge) => edge.kind === 'call');
    const crossFile = calls.filter(
      (edge) => edge.source.split('#')[0] !== edge.target.split('#')[0],
    );
    const intoHubs = calls.filter((edge) => edge.target.startsWith('shared/hub'));

    expect(functions.length).toBe(project.functionCount);
    expect(graph.edges.filter((edge) => edge.kind === 'import').length).toBeGreaterThan(100);
    expect(crossFile.length).toBeGreaterThan(100);
    expect(intoHubs.length).toBeGreaterThan(10);
  });
});
