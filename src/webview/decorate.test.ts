import { describe, expect, it } from 'vitest';

import { ClassNameDecorator, joinClassNames } from './decorate';

describe('joinClassNames', () => {
  it('joins non-empty parts', () => {
    expect(joinClassNames('a', undefined, '', 'b')).toBe('a b');
    expect(joinClassNames(undefined, '')).toBeUndefined();
  });
});

describe('ClassNameDecorator', () => {
  it('adds classes and keeps undecorated items as-is', () => {
    const decorator = new ClassNameDecorator<{ id: string; className?: string }>();
    const plain = { id: 'b' };
    const result = decorator.apply([{ id: 'a', className: 'base' }, plain], (item) =>
      item.id === 'a' ? 'x' : undefined,
    );
    expect(result).toEqual([{ id: 'a', className: 'base x' }, plain]);
    expect(result[1]).toBe(plain);
  });

  it('reuses the previous object when source and class are unchanged', () => {
    const decorator = new ClassNameDecorator<{ id: string }>();
    const a = { id: 'a' };
    const b = { id: 'b' };
    const first = decorator.apply([a, b], () => 'x');
    const second = decorator.apply([a, b], (item) => (item.id === 'a' ? 'x' : 'y'));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toEqual({ id: 'b', className: 'y' });
  });

  it('rebuilds when the source object changes', () => {
    const decorator = new ClassNameDecorator<{ id: string; label: string }>();
    const first = decorator.apply([{ id: 'a', label: '1' }], () => 'x');
    const second = decorator.apply([{ id: 'a', label: '2' }], () => 'x');
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]).toEqual({ id: 'a', label: '2', className: 'x' });
  });
});
