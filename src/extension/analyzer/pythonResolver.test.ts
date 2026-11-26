import { beforeAll, describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../../shared';
import { IncrementalLinker } from './incrementalLinker';
import { linkGraph } from './linker';
import { parsePython, preparePython } from './pythonParser';
import { parseAnnotation } from './pythonResolver';
import type { ParsedFile } from './types';

beforeAll(async () => {
  await preparePython();
});

/**
 * Parses Python files given as `path → lines`.
 *
 * @param sources - Source lines by path.
 * @returns The parsed files.
 */
function parseAll(sources: Readonly<Record<string, readonly string[]>>): ParsedFile[] {
  return Object.entries(sources).map(([path, lines]) => parsePython(path, lines.join('\n')));
}

/**
 * Lists the call edges of a graph as `source -> target`.
 *
 * @param graph - Graph.
 * @returns Sorted edges.
 */
function calls(graph: Pick<GraphSnapshot, 'edges'>): string[] {
  return graph.edges
    .filter((edge) => edge.kind === 'call')
    .map((edge) => `${edge.source} -> ${edge.target}`)
    .sort();
}

const PROJECT = {
  'app/models.py': [
    'class Base:',
    '    def log(self): pass',
    'class Repo(Base):',
    '    def __init__(self, url: str): pass',
    '    def save(self) -> "Order": self.log()',
    'class Order:',
    '    lines: list["Line"]',
    '    def total(self) -> float:',
    '        for line in self.lines:',
    '            line.price()',
    'class Line:',
    '    def price(self) -> float: pass',
  ],
  'app/__init__.py': ['from .models import Repo', 'from .service import *'],
  'app/service.py': [
    'from __future__ import annotations',
    'from typing import TYPE_CHECKING',
    'from app import Repo',
    'if TYPE_CHECKING:',
    '    from .models import Order',
    '__all__ = ["Service", "make"]',
    'class Service:',
    '    def __init__(self, repo: Repo) -> None:',
    '        self.repo = repo',
    '    def place(self) -> Order:',
    '        order = self.repo.save()',
    '        order.total()',
    '        return order',
    'def make() -> Service:',
    '    return Service(Repo("db"))',
  ],
  'app/main.py': ['import app', 'def main():', '    app.make().place().total()'],
};

describe('PythonResolver', () => {
  it('follows types across modules, re-exports, fields, return types and bases', () => {
    expect(calls(linkGraph(parseAll(PROJECT), 1))).toEqual([
      'app/main.py#main -> app/models.py#Order.total',
      'app/main.py#main -> app/service.py#Service.place',
      'app/main.py#main -> app/service.py#make',
      'app/models.py#Order.total -> app/models.py#Line.price',
      'app/models.py#Repo.save -> app/models.py#Base.log',
      'app/service.py#Service.place -> app/models.py#Order.total',
      'app/service.py#Service.place -> app/models.py#Repo.save',
      'app/service.py#make -> app/models.py#Repo.__init__',
      'app/service.py#make -> app/service.py#Service.__init__',
    ]);
  });

  it('adds no edge when a value cannot be known', () => {
    const graph = linkGraph(
      parseAll({
        'a.py': [
          'import json',
          'def dumps(x): return json.dumps(x)',
          'def run(handler, items):',
          '    handler.save()',
          '    items[0].total()',
          '    unknown_name()',
        ],
      }),
      1,
    );
    expect(calls(graph)).toEqual([]);
  });

  it('relinks files that resolved types through a changed file, like a full link', () => {
    const files = new Map(parseAll(PROJECT).map((file) => [file.filePath, file]));
    const linker = new IncrementalLinker();
    linker.apply({ upserts: [...files.values()], removals: [] });
    // `save` now returns a Line: callers in other files must follow.
    const changed = parsePython(
      'app/models.py',
      [
        ...PROJECT['app/models.py'].slice(0, 4),
        '    def save(self) -> "Line": self.log()',
        ...PROJECT['app/models.py'].slice(5),
      ].join('\n'),
    );
    files.set(changed.filePath, changed);
    linker.apply({ upserts: [changed], removals: [] });
    expect(calls(linker.snapshot(2))).toEqual(calls(linkGraph(files.values(), 2)));
    expect(calls(linker.snapshot(2))).not.toContain(
      'app/service.py#Service.place -> app/models.py#Order.total',
    );
  });
});

describe('parseAnnotation', () => {
  it('reads unions, optionals, wrappers, collections and quoted names', () => {
    expect(parseAnnotation('"Repo" | None')).toEqual([{ k: 'name', path: ['Repo'] }]);
    expect(parseAnnotation('Optional[m.Order]')).toEqual([{ k: 'name', path: ['m', 'Order'] }]);
    expect(parseAnnotation('Annotated[Service, Depends(get)]')).toEqual([
      { k: 'name', path: ['Service'] },
    ]);
    expect(parseAnnotation('list[Order]')).toEqual([
      { k: 'items', of: [{ k: 'name', path: ['Order'] }] },
    ]);
    expect(parseAnnotation('tuple[A, B, ...]')).toEqual([
      {
        k: 'items',
        of: [
          { k: 'name', path: ['A'] },
          { k: 'name', path: ['B'] },
        ],
      },
    ]);
    expect(parseAnnotation('type[Base]')).toEqual([
      { k: 'class', of: [{ k: 'name', path: ['Base'] }] },
    ]);
    expect(parseAnnotation('Registry[Gateway]')).toEqual([{ k: 'name', path: ['Registry'] }]);
    expect(parseAnnotation('dict[str, Order]')).toEqual([]);
    expect(parseAnnotation('None')).toEqual([]);
  });
});
