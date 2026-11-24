import { beforeAll, describe, expect, it } from 'vitest';

import { resolveGoPackage } from './goLanguage';
import { goPackageName, parseGo, prepareGo } from './goParser';
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

/** Source covering the supported Go constructs. */
const SOURCE = `package service

import (
	"fmt"
	db "example.com/app/internal/db"
	"example.com/app/internal/util"
	_ "example.com/app/internal/plugins"
	yaml "gopkg.in/yaml.v3"
)

type Store interface {
	Save(u User) error
	reset()
}

type UserService struct {
	Base
	repo  *db.Repo
	cache map[string]int
}

func NewUserService(r *db.Repo) *UserService { return &UserService{repo: r} }

func (s *UserService) Save(u User) error {
	v := NewValidator()
	local := newCache()
	var w Validator
	r := &db.Repo{}
	other := db.Open()
	v.Check(u)
	s.repo.Save(u)
	r.Flush()
	w.Run()
	local.Clear()
	other.Close()
	db.Open()
	util.Trim("x")
	helper()
	fmt.Println(yaml.Marshal(u))
	return nil
}

func newCache() *Cache { return nil }

func helper() {}
`;

describe('parseGo', () => {
  let parsed: ParsedFile;

  beforeAll(async () => {
    await prepareGo();
    parsed = parseGo('internal/service/service.go', SOURCE);
  });

  it('uses the folder as namespace and binds imports to their package name', () => {
    expect(parsed.namespace).toBe('internal/service');
    expect(parsed.imports.map((entry) => [entry.specifier, entry.bindings[0]?.localName])).toEqual([
      ['fmt', 'fmt'],
      ['example.com/app/internal/db', 'db'],
      ['example.com/app/internal/util', 'util'],
      ['example.com/app/internal/plugins', undefined],
      ['gopkg.in/yaml.v3', 'yaml'],
    ]);
    expect(parsed.imports.every((entry) => entry.target === 'package')).toBe(true);
  });

  it('reads struct fields, embedded types and interface methods', () => {
    expect(parsed.types).toEqual([
      { name: 'Store', namespace: 'internal/service', bases: [], fields: {} },
      {
        name: 'UserService',
        namespace: 'internal/service',
        bases: ['Base'],
        fields: { repo: 'db.Repo' },
      },
    ]);
    expect(parsed.functions.map((fn) => [fn.qualifiedName, fn.functionKind, fn.exported])).toEqual([
      ['Store.Save', 'method', true],
      ['Store.reset', 'method', false],
      ['NewUserService', 'function', true],
      ['UserService.Save', 'method', true],
      ['newCache', 'function', false],
      ['helper', 'function', false],
    ]);
    expect(parsed.functions[2]?.resultType).toBe('UserService');
  });

  it('types calls with the receiver, locals, literals and function results', () => {
    const save = parsed.functions.find((fn) => fn.qualifiedName === 'UserService.Save');
    expect(save?.calls.map(withoutLine)).toEqual([
      { kind: 'identifier', name: 'NewValidator' },
      { kind: 'identifier', name: 'newCache' },
      { kind: 'member', receiver: 'db', name: 'Open' },
      { kind: 'member', receiver: 'v', receiverType: 'call:NewValidator', name: 'Check' },
      {
        kind: 'member',
        receiver: 's.repo',
        receiverType: 'UserService',
        receiverField: 'repo',
        name: 'Save',
      },
      { kind: 'member', receiver: 'r', receiverType: 'db.Repo', name: 'Flush' },
      { kind: 'member', receiver: 'w', receiverType: 'Validator', name: 'Run' },
      { kind: 'member', receiver: 'local', receiverType: 'Cache', name: 'Clear' },
      { kind: 'member', receiver: 'other', receiverType: 'call:db.Open', name: 'Close' },
      { kind: 'member', receiver: 'db', name: 'Open' },
      { kind: 'member', receiver: 'util', name: 'Trim' },
      { kind: 'identifier', name: 'helper' },
      { kind: 'member', receiver: 'fmt', name: 'Println' },
      { kind: 'member', receiver: 'yaml', name: 'Marshal' },
    ]);
  });

  it('survives syntax errors', () => {
    expect(() => parseGo('broken.go', 'func ( {')).not.toThrow();
  });
});

describe('Go packages', () => {
  it('names packages by their last path segment, skipping major versions', () => {
    expect(goPackageName('example.com/app/db')).toBe('db');
    expect(goPackageName('github.com/x/client/v2')).toBe('client');
  });

  it('matches import paths to the longest workspace folder they end with', () => {
    const packages = new Set(['', 'db', 'internal/db', 'http']);
    expect(resolveGoPackage('example.com/app/internal/db', packages)).toBe('internal/db');
    expect(resolveGoPackage('myapp/db', packages)).toBe('db');
    expect(resolveGoPackage('net/http', packages)).toBeNull();
    expect(resolveGoPackage('github.com/other/lib', packages)).toBeNull();
  });
});
