import { beforeAll, describe, expect, it } from 'vitest';

import type { PyExpr } from './pythonModel';
import { parsePython, preparePython } from './pythonParser';
import type { ParsedFile } from './types';

/**
 * Renders an expression compactly for assertions.
 *
 * @param expr - Expression.
 * @returns E.g. `self.repo.save`, `Order()`, `<list[Order]>`.
 */
function render(expr: PyExpr): string {
  switch (expr.t) {
    case 'name':
      return expr.name;
    case 'attr':
      return `${render(expr.of)}.${expr.name}`;
    case 'call':
      return `${render(expr.of)}()`;
    case 'self':
    case 'cls':
      return expr.t;
    case 'super':
      return 'super()';
    case 'ann':
      return `<${expr.text}>`;
    case 'elem':
      return `elem(${render(expr.of)})`;
    case 'enter':
      return `enter(${render(expr.of)})`;
    case 'items':
      return `[${render(expr.of)}]`;
    case 'any':
      return `(${expr.of.map(render).join('|')})`;
    case 'unknown':
      return '?';
  }
}

/** Source covering every supported Python construct. */
const SOURCE = [
  'import os',
  'import os.path',
  'import numpy as np',
  'from . import config',
  'from ..utils import slugify, normalize as norm',
  'from pkg.mod import *',
  '',
  'def main():',
  '    config.load()',
  '    slugify(np.array([1]))',
  '    def inner():',
  '        helper()',
  '    return inner()',
  '',
  'def _private():',
  '    pass',
  '',
  '@dataclass',
  'class Box:',
  '    @staticmethod',
  '    def make():',
  '        return Box()',
  '',
  '    def run(self):',
  '        self.stop()',
  '        cls.reset()',
  '        obj.thing().go()',
  '',
  '    def stop(self):',
  '        pass',
  '',
  'shout = lambda text: norm(text)',
  'value = 3',
  'main()',
].join('\n');

beforeAll(async () => {
  await preparePython();
});

/**
 * Parses the sample source.
 *
 * @returns The parsed file.
 */
function parsed(): ParsedFile {
  return parsePython('app/pkg/mod.py', SOURCE);
}

describe('parsePython', () => {
  it('collects imports with their bindings, including possible submodules', () => {
    expect(parsed().imports).toEqual([
      {
        specifier: 'os',
        syntax: 'import',
        line: 1,
        bindings: [{ kind: 'namespace', importedName: '*', localName: 'os' }],
      },
      { specifier: 'os.path', syntax: 'import', line: 2, bindings: [] },
      {
        specifier: 'numpy',
        syntax: 'import',
        line: 3,
        bindings: [{ kind: 'namespace', importedName: '*', localName: 'np' }],
      },
      {
        specifier: '.',
        syntax: 'import',
        line: 4,
        bindings: [{ kind: 'named', importedName: 'config', localName: 'config' }],
        lookupOnly: true,
      },
      {
        specifier: '.config',
        syntax: 'import',
        line: 4,
        bindings: [{ kind: 'namespace', importedName: '*', localName: 'config' }],
      },
      {
        specifier: '..utils',
        syntax: 'import',
        line: 5,
        bindings: [
          { kind: 'named', importedName: 'slugify', localName: 'slugify' },
          { kind: 'named', importedName: 'normalize', localName: 'norm' },
        ],
        lookupOnly: true,
      },
      {
        specifier: '..utils.slugify',
        syntax: 'import',
        line: 5,
        bindings: [{ kind: 'namespace', importedName: '*', localName: 'slugify' }],
      },
      {
        specifier: '..utils.normalize',
        syntax: 'import',
        line: 5,
        bindings: [{ kind: 'namespace', importedName: '*', localName: 'norm' }],
      },
      { specifier: 'pkg.mod', syntax: 'import', line: 6, bindings: [], star: true },
    ]);
  });

  it('collects functions, methods and top-level lambdas; nested functions belong to their parent', () => {
    expect(
      parsed().functions.map((fn) => [
        fn.qualifiedName,
        fn.functionKind,
        fn.line,
        fn.endLine,
        fn.exported,
      ]),
    ).toEqual([
      ['main', 'function', 8, 13, true],
      ['_private', 'function', 15, 16, false],
      ['Box.make', 'method', 21, 22, true],
      ['Box.run', 'method', 24, 27, true],
      ['Box.stop', 'method', 29, 30, true],
      ['shout', 'arrow', 32, 32, true],
    ]);
  });

  it('records the uses of each function as expressions', () => {
    const uses = Object.fromEntries(
      parsed().functions.map((fn) => [
        fn.qualifiedName,
        (fn.python?.uses ?? []).filter((use) => use.kind === 'call').map((use) => render(use.expr)),
      ]),
    );
    expect(uses.main).toEqual(['config.load', 'slugify', 'np.array', 'helper', '?']);
    expect(uses['Box.make']).toEqual(['Box']);
    expect(uses['Box.run']).toEqual(['self.stop', 'cls.reset', 'obj.thing().go', 'obj.thing']);
    expect(uses.shout).toEqual(['norm']);
  });

  it('exports every top-level function, class, lambda and variable', () => {
    expect(parsed().exports.map((entry) => entry.exportedName)).toEqual([
      'main',
      '_private',
      'Box',
      'shout',
      'value',
    ]);
  });

  it('does not throw on syntax errors', () => {
    const broken = parsePython('x.py', 'def ok():\n    pass\n\ndef broken(:\n');
    expect(broken.functions.map((fn) => fn.name)).toContain('ok');
  });

  it('records classes: bases, fields from the body and from self, protocols, nested classes', () => {
    const file = parsePython(
      'm.py',
      [
        'from typing import Protocol',
        'class Port(Protocol):',
        '    def save(self) -> None: ...',
        'class Base: pass',
        'class Repo(Base, metaclass=Meta):',
        '    table: str = "t"',
        '    def __init__(self, session: Session, cache=None):',
        '        self.session = session',
        '        self.cache = Cache()',
        '        self.items: list[Item] = []',
        '    class Meta:',
        '        def describe(): pass',
      ].join('\n'),
    );
    const classes = file.python?.classes ?? [];
    expect(
      classes.map((pyClass) => [pyClass.name, pyClass.bases.map(render), pyClass.protocol]),
    ).toEqual([
      ['Port', ['Protocol'], true],
      ['Base', [], false],
      ['Repo', ['Base'], false],
      ['Repo.Meta', [], false],
    ]);
    const fields = classes.find((pyClass) => pyClass.name === 'Repo')?.fields ?? {};
    expect(
      Object.fromEntries(Object.entries(fields).map(([name, expr]) => [name, render(expr)])),
    ).toEqual({
      table: '<str>',
      session: '<Session>',
      cache: 'Cache()',
      items: '<list[Item]>',
    });
    expect(file.functions.map((fn) => fn.qualifiedName)).toEqual([
      'Port.save',
      'Repo.__init__',
      'Repo.Meta.describe',
    ]);
    expect(file.functions[0]?.python?.abstract).toBe(true);
  });

  it('replaces variables by their values: parameters, locals, loops, with, walrus, comprehensions', () => {
    const file = parsePython(
      'm.py',
      [
        'def run(repo: Repo, items: list[Item], *notifiers: Notifier):',
        '    order = Order(1)',
        '    order.add()',
        '    for item in items:',
        '        item.price()',
        '    with open_session() as session:',
        '        session.add()',
        '    if (found := repo.get()) is not None:',
        '        found.ship()',
        '    [line.total() for line in order.lines]',
        '    for notifier in notifiers:',
        '        notifier.send()',
        '    order = make()',
        '    order.add()',
      ].join('\n'),
    );
    const calls = (file.functions[0]?.python?.uses ?? [])
      .filter((use) => use.kind === 'call')
      .map((use) => render(use.expr));
    expect(calls).toEqual([
      'Order',
      'Order().add',
      'elem(<list[Item]>).price',
      'open_session',
      'enter(open_session()).add',
      '<Repo>.get',
      '<Repo>.get().ship',
      'elem(Order().lines).total',
      'elem(<tuple[Notifier, ...]>).send',
      'make',
      'make().add',
    ]);
  });

  it('records signatures, decorators, references and attribute reads', () => {
    const file = parsePython(
      'm.py',
      [
        'class Service:',
        '    @property',
        '    def count(self) -> int:',
        '        return len(self.repo.all())',
        '    @staticmethod',
        '    def check(x): pass',
        '    @classmethod',
        '    def create(cls) -> "Service":',
        '        return cls()',
        '    @retry(times=2)',
        '    @timed',
        '    def run(self, handler=Depends(get_handler)):',
        '        sorted(self.items, key=item_key)',
        '        return self.count',
      ].join('\n'),
    );
    const [count, check, create, run] = file.functions;
    expect([count?.python?.property, count?.python?.returns]).toEqual([
      true,
      { t: 'ann', text: 'int' },
    ]);
    expect(check?.python?.static).toBe(true);
    expect(create?.python?.returns).toEqual({ t: 'ann', text: 'Service' });
    expect(create?.python?.uses.map((use) => `${use.kind}:${render(use.expr)}`)).toEqual([
      'call:cls',
    ]);
    expect(run?.python?.uses.map((use) => `${use.kind}:${render(use.expr)}`)).toEqual([
      'call:retry',
      'call:timed',
      'call:Depends',
      'ref:get_handler',
      'call:sorted',
      'ref:self.items',
      'ref:item_key',
      'read:self.count',
    ]);
  });

  it('walks module-level blocks: TYPE_CHECKING imports, branches, overloads and module code', () => {
    const file = parsePython(
      'm.py',
      [
        'from typing import TYPE_CHECKING, overload',
        'if TYPE_CHECKING:',
        '    from .models import Order',
        'if FAST:',
        '    def speed(): pass',
        'else:',
        '    def speed(): pass',
        '@overload',
        'def parse(x: int) -> int: ...',
        'def parse(x): pass',
        'def local():',
        '    from .helpers import helper',
        '    helper()',
        'router = Router()',
        '__all__ = ["speed", "parse"]',
        'if __name__ == "__main__":',
        '    local()',
      ].join('\n'),
    );
    expect(file.imports.map((entry) => entry.specifier)).toEqual([
      'typing',
      'typing.TYPE_CHECKING',
      'typing.overload',
      '.models',
      '.models.Order',
      '.helpers',
      '.helpers.helper',
    ]);
    expect(file.functions.map((fn) => [fn.qualifiedName, fn.line])).toEqual([
      ['speed', 5],
      ['parse', 10],
      ['local', 11],
    ]);
    expect(file.python?.all).toEqual(['speed', 'parse']);
    expect(file.python?.variables.router).toEqual({ t: 'call', of: { t: 'name', name: 'Router' } });
    expect(
      file.python?.uses.filter((use) => use.kind === 'call').map((use) => render(use.expr)),
    ).toEqual(['Router', 'local']);
  });

  it('keeps self when assigning to its attributes or items', () => {
    const file = parsePython(
      'm.py',
      [
        'class A:',
        '    def __init__(self, host):',
        '        (self.host, self.port) = split(host)',
        '        self.items[0] = None',
        '        a, (b, c) = pair()',
        '        self.check(a, b)',
      ].join('\n'),
    );
    const calls = (file.functions[0]?.python?.uses ?? [])
      .filter((use) => use.kind === 'call')
      .map((use) => render(use.expr));
    expect(calls).toEqual(['split', 'pair', 'self.check']);
  });
});
