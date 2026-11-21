/**
 * Incremental CSS-class decoration of React Flow elements.
 */

/** Element that can receive a CSS class. */
interface Decoratable {
  readonly id: string;
  readonly className?: string;
}

/** A previously decorated element and the inputs it was built from. */
interface CacheEntry<T> {
  readonly source: T;
  readonly extraClass: string | undefined;
  readonly decorated: T;
}

/**
 * Joins CSS class lists, skipping empty parts.
 *
 * @param parts - Class lists.
 * @returns The joined class list, or `undefined` if empty.
 */
export function joinClassNames(...parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter((part) => part !== undefined && part !== '').join(' ');
  return joined === '' ? undefined : joined;
}

/**
 * Adds extra CSS classes to elements while reusing the previous object for
 * every element whose source and class did not change. React Flow skips
 * re-rendering elements with an unchanged reference, so a search keystroke
 * only re-renders the nodes whose highlight actually changed.
 */
export class ClassNameDecorator<T extends Decoratable> {
  private cache = new Map<string, CacheEntry<T>>();

  /**
   * Decorates elements.
   *
   * @param items - Elements to decorate.
   * @param extraClassOf - Extra class for an element, or `undefined` for none.
   * @returns Decorated elements (unchanged ones keep their previous reference).
   */
  public apply(items: readonly T[], extraClassOf: (item: T) => string | undefined): T[] {
    const next = new Map<string, CacheEntry<T>>();
    const result = items.map((item) => {
      const extraClass = extraClassOf(item);
      const cached = this.cache.get(item.id);
      const decorated =
        cached?.source === item && cached.extraClass === extraClass
          ? cached.decorated
          : this.decorate(item, extraClass);
      next.set(item.id, { source: item, extraClass, decorated });
      return decorated;
    });
    this.cache = next;
    return result;
  }

  /**
   * Builds the decorated copy of an element.
   *
   * @param item - Source element.
   * @param extraClass - Extra class, if any.
   * @returns The element itself when there is nothing to add, otherwise a copy.
   */
  private decorate(item: T, extraClass: string | undefined): T {
    if (extraClass === undefined) {
      return item;
    }
    const className = joinClassNames(item.className, extraClass);
    return className === undefined ? item : { ...item, className };
  }
}
