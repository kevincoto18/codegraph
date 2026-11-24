import { beforeAll, describe, expect, it } from 'vitest';

import { parseJava, prepareJava } from './javaParser';
import type { ParsedCall, ParsedFile } from './types';

/**
 * Drops the line of a call, to compare calls by shape.
 *
 * @param call - Parsed call.
 * @returns The call without its line.
 */
function withoutLine(call: ParsedCall): Record<string, unknown> {
  return Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'line'));
}

/** Source covering the supported Java constructs. */
const SOURCE = `package com.app.service;

import com.app.db.Repo;
import com.app.util.*;
import static com.app.util.Strings.trim;

public class UserService extends BaseService implements Api, Closeable {
  private final Repo repo;
  private Cache<String, User> cache;

  public UserService(Repo repo) { this.repo = repo; init(); }

  public User save(User user, List<Tag> tags) {
    var validator = new Validator();
    Checker checker = validator;
    validator.check(user);
    checker.verify(user);
    this.repo.store(user);
    this.audit.log(user);
    repo.flush();
    Repo.open();
    helper();
    super.close();
    for (Tag tag : tags) { tag.apply(); }
    items.stream().forEach(x -> x.run());
    return user;
  }

  static void helper() {}

  interface Listener { void onSave(User user); }

  enum Mode { ON, OFF; void toggle() { reset(); } }
}

record Point(Coordinate x, int y) { double length() { return x.norm(); } }
`;

describe('parseJava', () => {
  let parsed: ParsedFile;

  beforeAll(async () => {
    await prepareJava();
    parsed = parseJava('src/com/app/service/UserService.java', SOURCE);
  });

  it('reads the package and imports by kind', () => {
    expect(parsed.namespace).toBe('com.app.service');
    expect(
      parsed.imports.map((entry) => [entry.target, entry.specifier, entry.bindings.length]),
    ).toEqual([
      ['type', 'com.app.db.Repo', 1],
      ['namespace', 'com.app.util', 0],
      ['type', 'com.app.util.Strings', 0],
    ]);
  });

  it('reads types with bases and field types, nested types included', () => {
    expect(parsed.types).toEqual([
      {
        name: 'UserService',
        namespace: 'com.app.service',
        bases: ['BaseService', 'Api', 'Closeable'],
        fields: { repo: 'Repo', cache: 'Cache' },
      },
      { name: 'Listener', namespace: 'com.app.service', bases: [], fields: {} },
      { name: 'Mode', namespace: 'com.app.service', bases: [], fields: {} },
      { name: 'Point', namespace: 'com.app.service', bases: [], fields: { x: 'Coordinate' } },
    ]);
  });

  it('reads methods, constructors and interface methods', () => {
    expect(parsed.functions.map((fn) => [fn.qualifiedName, fn.className, fn.exported])).toEqual([
      ['UserService.constructor', 'UserService', true],
      ['UserService.save', 'UserService', true],
      ['UserService.helper', 'UserService', false],
      ['UserService.Listener.onSave', 'Listener', true],
      ['UserService.Mode.toggle', 'Mode', false],
      ['Point.length', 'Point', false],
    ]);
  });

  it('types calls with parameters, locals, fields and new expressions', () => {
    const save = parsed.functions.find((fn) => fn.name === 'save');
    expect(save?.calls.map(withoutLine)).toEqual([
      { kind: 'member', receiverType: 'Validator', name: 'constructor' },
      { kind: 'member', receiver: 'validator', receiverType: 'Validator', name: 'check' },
      { kind: 'member', receiver: 'checker', receiverType: 'Checker', name: 'verify' },
      { kind: 'member', receiver: 'this.repo', receiverType: 'Repo', name: 'store' },
      {
        kind: 'member',
        receiver: 'this.audit',
        receiverType: 'UserService',
        receiverField: 'audit',
        name: 'log',
      },
      { kind: 'member', receiver: 'repo', receiverType: 'Repo', name: 'flush' },
      { kind: 'member', receiver: 'Repo', name: 'open' },
      { kind: 'this-member', name: 'helper' },
      { kind: 'this-member', name: 'close' },
      { kind: 'member', receiver: 'tag', receiverType: 'Tag', name: 'apply' },
      { kind: 'member', receiver: 'items', name: 'stream' },
      { kind: 'member', receiver: 'x', name: 'run' },
    ]);
    const constructor = parsed.functions[0];
    expect(constructor?.calls).toEqual([{ kind: 'this-member', name: 'init', line: 11 }]);
    expect(parsed.functions.at(-1)?.calls).toEqual([
      { kind: 'member', receiver: 'x', receiverType: 'Coordinate', name: 'norm', line: 36 },
    ]);
  });

  it('survives syntax errors', () => {
    expect(() => parseJava('Broken.java', 'class { void (')).not.toThrow();
  });
});
