import { beforeAll, describe, expect, it } from 'vitest';

import { parseCSharp, prepareCSharp } from './csharpParser';
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

/** Source covering the supported C# constructs. */
const SOURCE = `using System;
using App.Data;
using R = App.Data.Repo;
using static App.Util.Strings;

namespace App.Services
{
    public class UserService : BaseService, IApi
    {
        private readonly Repo _repo;
        public Cache Store { get; set; }

        public UserService(Repo repo) { _repo = repo; Init(); }

        public User Save(User user)
        {
            var validator = new Validator();
            Checker checker = validator;
            validator.Check(user);
            checker.Verify(user);
            this._repo.Store(user);
            this.Audit.Log(user);
            _repo.Flush();
            _repo?.Close();
            Repo.Open();
            Helper<int>();
            base.Dispose();
            foreach (var tag in user.Tags) { tag.Apply(); }
            return user;
        }

        public int Count => _repo.Count();

        internal static void Helper<T>() { }

        public interface IListener { void OnSave(User user); }
    }

    namespace Inner
    {
        record Point(Coordinate X, int Y);
    }
}
`;

describe('parseCSharp', () => {
  let parsed: ParsedFile;

  beforeAll(async () => {
    await prepareCSharp();
    parsed = parseCSharp('Services/UserService.cs', SOURCE);
  });

  it('reads the namespace and using directives by kind', () => {
    expect(parsed.namespace).toBe('App.Services');
    expect(
      parsed.imports.map((entry) => [entry.target, entry.specifier, entry.bindings[0]?.localName]),
    ).toEqual([
      ['namespace', 'System', undefined],
      ['namespace', 'App.Data', undefined],
      ['type', 'App.Data.Repo', 'R'],
      ['type', 'App.Util.Strings', undefined],
    ]);
  });

  it('reads types with bases, fields and properties, nested namespaces included', () => {
    expect(parsed.types).toEqual([
      {
        name: 'UserService',
        namespace: 'App.Services',
        bases: ['BaseService', 'IApi'],
        fields: { _repo: 'Repo', Store: 'Cache' },
      },
      { name: 'IListener', namespace: 'App.Services', bases: [], fields: {} },
      { name: 'Point', namespace: 'App.Services.Inner', bases: [], fields: { X: 'Coordinate' } },
    ]);
  });

  it('reads constructors, methods, properties with code and interface methods', () => {
    expect(parsed.functions.map((fn) => [fn.qualifiedName, fn.exported])).toEqual([
      ['UserService.constructor', true],
      ['UserService.Save', true],
      ['UserService.Count', true],
      ['UserService.Helper', true],
      ['UserService.IListener.OnSave', true],
    ]);
  });

  it('types calls with parameters, locals, fields and new expressions', () => {
    const save = parsed.functions.find((fn) => fn.name === 'Save');
    expect(save?.calls.map(withoutLine)).toEqual([
      { kind: 'member', receiverType: 'Validator', name: 'constructor' },
      { kind: 'member', receiver: 'validator', receiverType: 'Validator', name: 'Check' },
      { kind: 'member', receiver: 'checker', receiverType: 'Checker', name: 'Verify' },
      { kind: 'member', receiver: 'this._repo', receiverType: 'Repo', name: 'Store' },
      {
        kind: 'member',
        receiver: 'this.Audit',
        receiverType: 'UserService',
        receiverField: 'Audit',
        name: 'Log',
      },
      { kind: 'member', receiver: '_repo', receiverType: 'Repo', name: 'Flush' },
      { kind: 'member', receiver: '_repo', receiverType: 'Repo', name: 'Close' },
      { kind: 'member', receiver: 'Repo', name: 'Open' },
      { kind: 'this-member', name: 'Helper' },
      { kind: 'this-member', name: 'Dispose' },
      { kind: 'member', receiver: 'tag', name: 'Apply' },
    ]);
    const count = parsed.functions.find((fn) => fn.name === 'Count');
    expect(count?.calls).toEqual([
      { kind: 'member', receiver: '_repo', receiverType: 'Repo', name: 'Count', line: 32 },
    ]);
  });

  it('survives syntax errors', () => {
    expect(() => parseCSharp('Broken.cs', 'class { void (')).not.toThrow();
  });
});
