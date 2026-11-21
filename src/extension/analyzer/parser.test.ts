import { describe, expect, it } from 'vitest';

import { parseSource } from './parser';
import type { ParsedFile, ParsedFunction } from './types';

/**
 * Finds a parsed function by qualified name or fails the test.
 *
 * @param parsed - Parser output.
 * @param qualifiedName - Qualified name to look for.
 * @returns The matching function.
 * @throws Error if no function has that qualified name.
 */
function getFunction(parsed: ParsedFile, qualifiedName: string): ParsedFunction {
  const found = parsed.functions.find((fn) => fn.qualifiedName === qualifiedName);
  if (found === undefined) {
    throw new Error(`Function "${qualifiedName}" not found.`);
  }
  return found;
}

/**
 * Lists the qualified names of every parsed function.
 *
 * @param parsed - Parser output.
 * @returns Qualified names in source order.
 */
function functionNames(parsed: ParsedFile): string[] {
  return parsed.functions.map((fn) => fn.qualifiedName);
}

describe('parseSource — ES imports', () => {
  const parsed = parseSource(
    'src/app.ts',
    [
      "import React from 'react';",
      "import { a, b as bee } from './ab';",
      "import * as utils from './utils';",
      "import Def, { named } from './mixed';",
      "import './side-effect';",
      "import type { T } from './types';",
      "export { x } from './reexport';",
      "export * from './star';",
    ].join('\n'),
  );

  it('collects every import in source order with its line', () => {
    expect(parsed.imports.map((i) => [i.specifier, i.syntax, i.line])).toEqual([
      ['react', 'import', 1],
      ['./ab', 'import', 2],
      ['./utils', 'import', 3],
      ['./mixed', 'import', 4],
      ['./side-effect', 'import', 5],
      ['./types', 'import', 6],
      ['./reexport', 're-export', 7],
      ['./star', 're-export', 8],
    ]);
  });

  it('extracts default, named (with alias) and namespace bindings', () => {
    expect(parsed.imports[0]?.bindings).toEqual([
      { kind: 'default', importedName: 'default', localName: 'React' },
    ]);
    expect(parsed.imports[1]?.bindings).toEqual([
      { kind: 'named', importedName: 'a', localName: 'a' },
      { kind: 'named', importedName: 'b', localName: 'bee' },
    ]);
    expect(parsed.imports[2]?.bindings).toEqual([
      { kind: 'namespace', importedName: '*', localName: 'utils' },
    ]);
    expect(parsed.imports[3]?.bindings).toEqual([
      { kind: 'default', importedName: 'default', localName: 'Def' },
      { kind: 'named', importedName: 'named', localName: 'named' },
    ]);
  });

  it('has no bindings for side-effect imports and re-exports', () => {
    expect(parsed.imports[4]?.bindings).toEqual([]);
    expect(parsed.imports[6]?.bindings).toEqual([]);
  });
});

describe('parseSource — CommonJS imports', () => {
  const parsed = parseSource(
    'lib/app.js',
    [
      "const fs = require('fs');",
      "const helpers = require('./helpers');",
      "const { format, parse: parseDate, ...rest } = require('./dates');",
      "require('./polyfill');",
      "const notRequire = load('./x');",
    ].join('\n'),
  );

  it('collects require calls as imports and ignores other calls', () => {
    expect(parsed.imports.map((i) => [i.specifier, i.syntax])).toEqual([
      ['fs', 'require'],
      ['./helpers', 'require'],
      ['./dates', 'require'],
      ['./polyfill', 'require'],
    ]);
  });

  it('maps identifiers to namespace bindings and destructuring to named bindings', () => {
    expect(parsed.imports[1]?.bindings).toEqual([
      { kind: 'namespace', importedName: '*', localName: 'helpers' },
    ]);
    expect(parsed.imports[2]?.bindings).toEqual([
      { kind: 'named', importedName: 'format', localName: 'format' },
      { kind: 'named', importedName: 'parse', localName: 'parseDate' },
    ]);
    expect(parsed.imports[3]?.bindings).toEqual([]);
  });

  it('supports TypeScript import-equals require', () => {
    const tsParsed = parseSource('src/a.ts', "import legacy = require('./legacy');");
    expect(tsParsed.imports).toEqual([
      {
        specifier: './legacy',
        syntax: 'require',
        line: 1,
        bindings: [{ kind: 'namespace', importedName: '*', localName: 'legacy' }],
      },
    ]);
  });
});

describe('parseSource — function declarations', () => {
  const parsed = parseSource(
    'src/service.ts',
    [
      'export function declared(): void {}', // 1
      'const arrow = () => 1;', // 2
      'const expr = function () { return 2; };', // 3
      'let notAFunction = 3;', // 4
      'export class UserService {', // 5
      '  private field = 1;', // 6
      '  constructor() {}', // 7
      '  save(): void {', // 8
      '    helper();', // 9
      '  }', // 10
      '  handle = () => {};', // 11
      '  #secret(): void {}', // 12
      '  get value(): number { return 1; }', // 13
      '  abstractLike(): void;', // 14
      '}', // 15
      'function overloaded(a: string): void;', // 16
      'function overloaded(a: number): void;', // 17
      'function overloaded(a: unknown): void {}', // 18
      'function outer(): void {', // 19
      '  function nested(): void {}', // 20
      '}', // 21
    ].join('\n'),
  );

  it('extracts declarations, function-valued variables and class members only', () => {
    expect(functionNames(parsed)).toEqual([
      'declared',
      'arrow',
      'expr',
      'UserService.constructor',
      'UserService.save',
      'UserService.handle',
      'UserService.#secret',
      'overloaded',
      'outer',
    ]);
  });

  it('reports the syntactic kind of each function', () => {
    expect(getFunction(parsed, 'declared').functionKind).toBe('function');
    expect(getFunction(parsed, 'arrow').functionKind).toBe('arrow');
    expect(getFunction(parsed, 'expr').functionKind).toBe('function');
    expect(getFunction(parsed, 'UserService.save').functionKind).toBe('method');
    expect(getFunction(parsed, 'UserService.handle').functionKind).toBe('method');
  });

  it('records the class name of methods', () => {
    const save = getFunction(parsed, 'UserService.save');
    expect(save.name).toBe('save');
    expect(save.className).toBe('UserService');
    expect(getFunction(parsed, 'declared')).not.toHaveProperty('className');
  });

  it('reports 1-based start and end lines', () => {
    expect(getFunction(parsed, 'declared')).toMatchObject({ line: 1, endLine: 1 });
    expect(getFunction(parsed, 'UserService.save')).toMatchObject({ line: 8, endLine: 10 });
    expect(getFunction(parsed, 'overloaded')).toMatchObject({ line: 18, endLine: 18 });
    expect(getFunction(parsed, 'outer')).toMatchObject({ line: 19, endLine: 21 });
  });

  it('marks exported functions and members of exported classes', () => {
    expect(getFunction(parsed, 'declared').exported).toBe(true);
    expect(getFunction(parsed, 'arrow').exported).toBe(false);
    expect(getFunction(parsed, 'UserService.save').exported).toBe(true);
  });
});

describe('parseSource — calls', () => {
  const parsed = parseSource(
    'src/calls.ts',
    [
      "import * as utils from './utils';",
      'setup();', // module-level call: ignored
      'export class Runner {', // 3
      '  run(): void {', // 4
      '    this.prepare();', // 5
      '    utils.log(1);', // 6
      '    format();', // 7
      '    [1].forEach(() => { inner(); });', // 8
      '    a.b.c();', // 9
      '    getFn()();', // 10
      "    require('./x');", // 11
      '    (wrapped as any)();', // 12
      '  }', // 13
      '  prepare(): void {}', // 14
      '}',
    ].join('\n'),
  );
  const calls = getFunction(parsed, 'Runner.run').calls;

  it('classifies identifier, member and this-member calls with lines', () => {
    expect(calls).toContainEqual({ kind: 'this-member', name: 'prepare', line: 5 });
    expect(calls).toContainEqual({ kind: 'member', name: 'log', receiver: 'utils', line: 6 });
    expect(calls).toContainEqual({ kind: 'identifier', name: 'format', line: 7 });
  });

  it('attributes calls inside nested closures to the enclosing function', () => {
    expect(calls).toContainEqual({ kind: 'identifier', name: 'inner', line: 8 });
  });

  it('ignores unresolvable shapes and require()', () => {
    const names = calls.map((call) => call.name);
    expect(names).not.toContain('c'); // a.b.c(): receiver is not a plain identifier
    expect(names).not.toContain('forEach'); // [1].forEach(): receiver is a literal
    expect(names).not.toContain('require');
    expect(names).toContain('getFn');
    expect(names).toContain('wrapped');
  });

  it('ignores module-level calls', () => {
    const allNames = parsed.functions.flatMap((fn) => fn.calls.map((call) => call.name));
    expect(allNames).not.toContain('setup');
  });
});

describe('parseSource — ES exports', () => {
  it('maps exported names to local declarations', () => {
    const parsed = parseSource(
      'src/exports.ts',
      [
        'export function a(): void {}',
        'export const b = () => {};',
        'function c(): void {}',
        'function d(): void {}',
        'export { c, d as dee };',
        'export default function main(): void {}',
        'export type { T } from "./t";',
      ].join('\n'),
    );
    expect(parsed.exports).toEqual([
      { exportedName: 'a', localName: 'a' },
      { exportedName: 'b', localName: 'b' },
      { exportedName: 'c', localName: 'c' },
      { exportedName: 'dee', localName: 'd' },
      { exportedName: 'default', localName: 'main' },
    ]);
    expect(getFunction(parsed, 'c').exported).toBe(true);
    expect(getFunction(parsed, 'd').exported).toBe(true);
    expect(getFunction(parsed, 'main').exported).toBe(true);
  });

  it('handles `export default <identifier>`', () => {
    const parsed = parseSource('src/a.ts', 'function run(): void {}\nexport default run;');
    expect(parsed.exports).toEqual([{ exportedName: 'default', localName: 'run' }]);
    expect(getFunction(parsed, 'run').exported).toBe(true);
  });

  it('creates a `default` function for anonymous default exports', () => {
    const declared = parseSource('src/a.ts', 'export default function () {}');
    expect(functionNames(declared)).toEqual(['default']);
    expect(declared.exports).toEqual([{ exportedName: 'default', localName: 'default' }]);

    const arrow = parseSource('src/b.ts', 'export default () => {};');
    expect(arrow.functions[0]).toMatchObject({
      name: 'default',
      functionKind: 'arrow',
      exported: true,
    });
  });
});

describe('parseSource — CommonJS exports', () => {
  it('handles module.exports object literals', () => {
    const parsed = parseSource(
      'lib/a.js',
      [
        'function a() {}',
        'function c() {}',
        'module.exports = {',
        '  a,',
        '  bee: c,',
        '  inlineArrow: () => {},',
        '  inlineMethod() {},',
        '  value: 42,',
        '};',
      ].join('\n'),
    );
    expect(parsed.exports).toEqual([
      { exportedName: 'a', localName: 'a' },
      { exportedName: 'bee', localName: 'c' },
      { exportedName: 'inlineArrow', localName: 'inlineArrow' },
      { exportedName: 'inlineMethod', localName: 'inlineMethod' },
    ]);
    expect(functionNames(parsed)).toEqual(['a', 'c', 'inlineArrow', 'inlineMethod']);
    expect(getFunction(parsed, 'c').exported).toBe(true);
  });

  it('handles exports.x and module.exports.x assignments', () => {
    const parsed = parseSource(
      'lib/b.js',
      [
        'function local() {}',
        'exports.one = local;',
        'module.exports.two = function () {};',
        'exports.three = () => {};',
      ].join('\n'),
    );
    expect(parsed.exports).toEqual([
      { exportedName: 'one', localName: 'local' },
      { exportedName: 'two', localName: 'two' },
      { exportedName: 'three', localName: 'three' },
    ]);
    expect(functionNames(parsed)).toEqual(['local', 'two', 'three']);
    expect(getFunction(parsed, 'three').functionKind).toBe('arrow');
  });

  it('treats `module.exports = fn` as the default export', () => {
    const named = parseSource('lib/c.js', 'function main() {}\nmodule.exports = main;');
    expect(named.exports).toEqual([{ exportedName: 'default', localName: 'main' }]);

    const inline = parseSource('lib/d.js', 'module.exports = function () {};');
    expect(functionNames(inline)).toEqual(['default']);
  });
});

describe('parseSource — file kinds', () => {
  it('parses JSX in .tsx files', () => {
    const parsed = parseSource(
      'src/App.tsx',
      'export function App() {\n  return <div onClick={() => track()}>hi</div>;\n}',
    );
    expect(getFunction(parsed, 'App').calls).toContainEqual({
      kind: 'identifier',
      name: 'track',
      line: 2,
    });
  });

  it('parses JSX in .jsx files', () => {
    const parsed = parseSource(
      'src/View.jsx',
      'export const View = () => <span>{render()}</span>;',
    );
    expect(getFunction(parsed, 'View').calls.map((c) => c.name)).toEqual(['render']);
  });

  it('recovers from syntax errors without throwing', () => {
    expect(() =>
      parseSource('src/broken.ts', 'function ok() {}\nfunction broken( {'),
    ).not.toThrow();
    expect(
      functionNames(parseSource('src/broken.ts', 'function ok() {}\nfunction broken( {')),
    ).toContain('ok');
  });
});
