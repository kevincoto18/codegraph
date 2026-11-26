import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

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

const POLYMORPHISM = {
  'ports.py': [
    'from abc import ABC, abstractmethod',
    'from typing import Protocol',
    'class Repo(Protocol):',
    '    def save(self) -> None: ...',
    '    def get(self) -> None: ...',
    'class Gateway(ABC):',
    '    @abstractmethod',
    '    def charge(self) -> None:',
    '        """Charges."""',
    '    def pay(self):',
    '        self.charge()',
    '    def log(self):',
    '        print("log")',
    'class Handler:',
    '    def handle(self):',
    '        pass',
    '    def run(self):',
    '        self.handle()',
  ],
  'impl.py': [
    'from ports import Gateway, Handler',
    'class SqlRepo:',
    '    def save(self): pass',
    '    def get(self): pass',
    'class HalfRepo:',
    '    def save(self): pass',
    'class Stripe(Gateway):',
    '    def charge(self):',
    '        super().charge()',
    '    def log(self):',
    '        super().log()',
    'class LooksLikeGateway:',
    '    def charge(self): pass',
    'class Echo(Handler):',
    '    def handle(self): print("hi")',
  ],
  'service.py': [
    'from ports import Repo, Gateway',
    'from impl import Stripe',
    'def place(repo: Repo, gateway: Gateway, stripe: Stripe):',
    '    repo.save()',
    '    gateway.charge()',
    '    gateway.log()',
    '    stripe.charge()',
  ],
};

describe('PythonResolver: polymorphism', () => {
  /**
   * Links the polymorphism project.
   *
   * @returns Its call edges.
   */
  const graph = (): string[] => calls(linkGraph(parseAll(POLYMORPHISM), 1));

  it('dispatches a Protocol method to the classes that define the whole protocol', () => {
    expect(graph()).toEqual(expect.arrayContaining(['service.py#place -> impl.py#SqlRepo.save']));
    // HalfRepo has `save` but not `get`: it is not a Repo.
    expect(graph()).not.toContain('service.py#place -> impl.py#HalfRepo.save');
  });

  it('dispatches an abstract method to subclasses only, never to look-alikes', () => {
    expect(graph()).toEqual(
      expect.arrayContaining([
        'service.py#place -> ports.py#Gateway.charge',
        'service.py#place -> impl.py#Stripe.charge',
        'ports.py#Gateway.pay -> impl.py#Stripe.charge',
      ]),
    );
    expect(graph()).not.toContain('service.py#place -> impl.py#LooksLikeGateway.charge');
  });

  it('dispatches empty hook methods (template method) to their overrides', () => {
    expect(graph()).toContain('ports.py#Handler.run -> impl.py#Echo.handle');
  });

  it('keeps concrete methods, super() calls and concrete receivers static', () => {
    // `log` has a body: calling it on a Gateway does not reach Stripe.log.
    expect(graph()).toContain('service.py#place -> ports.py#Gateway.log');
    expect(graph()).not.toContain('service.py#place -> impl.py#Stripe.log');
    // super().charge() runs the abstract method itself, not every override.
    expect(graph()).toContain('impl.py#Stripe.charge -> ports.py#Gateway.charge');
    expect(graph().filter((edge) => edge.startsWith('impl.py#Stripe.charge'))).toHaveLength(1);
    // A call on a Stripe runs Stripe.charge only.
    expect(graph().filter((edge) => edge.endsWith('#Stripe.charge'))).toEqual([
      'ports.py#Gateway.pay -> impl.py#Stripe.charge',
      'service.py#place -> impl.py#Stripe.charge',
    ]);
  });

  it('relinks callers when an implementation is added in another file', () => {
    const files = new Map(parseAll(POLYMORPHISM).map((file) => [file.filePath, file]));
    const linker = new IncrementalLinker();
    linker.apply({ upserts: [...files.values()], removals: [] });
    const added = parsePython(
      'extra.py',
      ['from ports import Gateway', 'class Paypal(Gateway):', '    def charge(self): pass'].join(
        '\n',
      ),
    );
    files.set(added.filePath, added);
    linker.apply({ upserts: [added], removals: [] });
    expect(calls(linker.snapshot(2))).toEqual(calls(linkGraph(files.values(), 2)));
    expect(calls(linker.snapshot(2))).toContain('service.py#place -> extra.py#Paypal.charge');
    files.delete('extra.py');
    linker.apply({ upserts: [], removals: ['extra.py'] });
    expect(calls(linker.snapshot(3))).toEqual(calls(linkGraph(files.values(), 3)));
  });
});

describe('PythonResolver: incremental linking', () => {
  it('matches a full link after every random change to the showcase sample', async () => {
    const root = resolve('samples/python-showcase');
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const sources = new Map<string, string>();
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.py')) {
        const path = join(entry.parentPath, entry.name);
        sources.set(relative(root, path).split('\\').join('/'), await readFile(path, 'utf8'));
      }
    }
    const paths = [...sources.keys()].sort();
    const files = new Map(paths.map((path) => [path, parsePython(path, sources.get(path) ?? '')]));
    const linker = new IncrementalLinker();
    linker.apply({ upserts: [...files.values()], removals: [] });

    let seed = 7;
    /**
     * Deterministic pseudo-random number.
     *
     * @returns A float in [0, 1).
     */
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let step = 2; step < 42; step += 1) {
      const path = paths[Math.floor(random() * paths.length)] ?? '';
      const roll = random();
      if (roll < 0.3 && files.has(path)) {
        files.delete(path);
        linker.apply({ upserts: [], removals: [path] });
      } else {
        // Re-add the file, sometimes without its return annotations.
        const source = sources.get(path) ?? '';
        const edited = roll < 0.6 ? source.replace(/\) -> [^:]+:/g, '):') : source;
        const parsed = parsePython(path, edited);
        files.set(path, parsed);
        linker.apply({ upserts: [parsed], removals: [] });
      }
      expect(calls(linker.snapshot(step)), `step ${String(step)}: ${path}`).toEqual(
        calls(linkGraph(files.values(), step)),
      );
    }
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
