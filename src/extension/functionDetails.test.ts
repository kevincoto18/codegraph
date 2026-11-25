import { describe, expect, it } from 'vitest';

import { extractFunctionDetails } from './functionDetails';

/**
 * Joins lines into a source text.
 *
 * @param lines - Lines.
 * @returns The text.
 */
function source(...lines: string[]): string {
  return lines.join('\n');
}

describe('extractFunctionDetails', () => {
  it('reads a TypeScript signature and the first paragraph of its TSDoc', () => {
    const text = source(
      'import x from "y";',
      '',
      '/**',
      ' * Registers a user and sends the welcome email.',
      ' *',
      ' * More details that are not shown.',
      ' * @param email - Address.',
      ' */',
      'export async function register(',
      '  email: string,',
      '  name: string,',
      '): Promise<User> {',
      '  return save(email, name);',
      '}',
    );
    expect(extractFunctionDetails(text, 'src/users.ts', 9)).toEqual({
      signature: 'export async function register(email: string, name: string): Promise<User>',
      doc: 'Registers a user and sends the welcome email.',
    });
  });

  it('stops arrow functions at the arrow and ignores braces inside parameters', () => {
    const text = source(
      '// Pads a number with zeros.',
      'export const pad = (value: number, { width }: { width: number }): string => {',
    );
    expect(extractFunctionDetails(text, 'a.ts', 2)).toEqual({
      signature: 'export const pad = (value: number, { width }: { width: number }): string',
      doc: 'Pads a number with zeros.',
    });
  });

  it('skips Java annotations and keeps the Javadoc above them', () => {
    const text = source(
      '    /** Saves the user. Returns the stored copy. */',
      '    @Override',
      '    public User save(User user) {',
    );
    expect(extractFunctionDetails(text, 'Repo.java', 3)).toEqual({
      signature: 'public User save(User user)',
      doc: 'Saves the user. Returns the stored copy.',
    });
  });

  it('reads C# XML doc comments', () => {
    const text = source(
      '/// <summary>',
      '/// Finds a user by <see cref="UserId"/>.',
      '/// </summary>',
      '/// <param name="id">The id.</param>',
      '[HttpGet]',
      'public User Find(UserId id) => repo.Get(id);',
    );
    expect(extractFunctionDetails(text, 'Users.cs', 6)).toEqual({
      signature: 'public User Find(UserId id)',
      doc: 'Finds a user by UserId.',
    });
  });

  it('reads Go comments and receivers', () => {
    const text = source(
      '// Save stores the user.',
      '// It returns an error when the store is full.',
      'func (r *Repo) Save(u User) error {',
    );
    expect(extractFunctionDetails(text, 'repo.go', 3)).toEqual({
      signature: 'func (r *Repo) Save(u User) error',
      doc: 'Save stores the user. It returns an error when the store is full.',
    });
  });

  it('reads Python docstrings, after decorators and multi-line parameters', () => {
    const text = source(
      '@app.route("/users")',
      'def create_user(',
      '    name: str,',
      ') -> User:',
      '    """Create a user.',
      '',
      '    Args:',
      '        name: the name.',
      '    """',
      '    return User(name)',
    );
    expect(extractFunctionDetails(text, 'app/users.py', 1)).toEqual({
      signature: 'def create_user(name: str) -> User',
      doc: 'Create a user.',
    });
  });

  it('falls back to # comments above a Python function and to no doc at all', () => {
    expect(
      extractFunctionDetails(
        source('# Adds two numbers.', 'def add(a, b):', '    return a + b'),
        'm.py',
        2,
      ),
    ).toEqual({ signature: 'def add(a, b)', doc: 'Adds two numbers.' });
    expect(extractFunctionDetails(source('x = 1', 'function run() {}'), 'r.js', 2)).toEqual({
      signature: 'function run()',
      doc: null,
    });
  });

  it('keeps object return types and stops interface methods at the end of the line', () => {
    expect(
      extractFunctionDetails(
        source('export function createApp(): { start(): void } {', '  return x;', '}'),
        'app.ts',
        1,
      )?.signature,
    ).toBe('export function createApp(): { start(): void }');
    expect(
      extractFunctionDetails(
        source(
          'type Repo interface {',
          '\tSave(user model.User) error',
          '}',
          '',
          'type Other struct {}',
        ),
        'repo.go',
        2,
      )?.signature,
    ).toBe('Save(user model.User) error');
    expect(
      extractFunctionDetails(source('  save(user: User): void;', '  find(): User;'), 'r.ts', 1)
        ?.signature,
    ).toBe('save(user: User): void');
  });

  it('returns null for a line outside the file', () => {
    expect(extractFunctionDetails('a', 'a.ts', 5)).toBeNull();
    expect(extractFunctionDetails('a', 'a.ts', 0)).toBeNull();
  });
});
