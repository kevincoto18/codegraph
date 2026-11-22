import { beforeAll, describe, expect, it } from 'vitest';

import { parsePython, preparePython } from './pythonParser';
import type { ParsedFile } from './types';

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
      { specifier: 'pkg.mod', syntax: 'import', line: 6, bindings: [] },
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

  it('collects resolvable calls only', () => {
    const calls = Object.fromEntries(
      parsed().functions.map((fn) => [
        fn.qualifiedName,
        fn.calls.map(
          (call) =>
            `${call.kind}:${call.receiver ?? ''}${call.receiver === undefined ? '' : '.'}${call.name}`,
        ),
      ]),
    );
    expect(calls.main).toEqual([
      'member:config.load',
      'identifier:slugify',
      'member:np.array',
      'identifier:helper',
      'identifier:inner',
    ]);
    expect(calls['Box.make']).toEqual(['identifier:Box']);
    // `obj.thing()` resolves; the chained `.go()` on its result does not.
    expect(calls['Box.run']).toEqual(['this-member:stop', 'this-member:reset', 'member:obj.thing']);
    expect(calls.shout).toEqual(['identifier:norm']);
  });

  it('exports every top-level function, class and lambda', () => {
    expect(parsed().exports.map((entry) => entry.exportedName)).toEqual([
      'main',
      '_private',
      'Box',
      'shout',
    ]);
  });

  it('does not throw on syntax errors', () => {
    const broken = parsePython('x.py', 'def ok():\n    pass\n\ndef broken(:\n');
    expect(broken.functions.map((fn) => fn.name)).toContain('ok');
  });
});
