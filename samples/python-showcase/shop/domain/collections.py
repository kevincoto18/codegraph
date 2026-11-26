"""A typed, generic registry. Named like a stdlib module on purpose:
``from collections import defaultdict`` elsewhere must not point here."""

from __future__ import annotations

from typing import Generic, Iterator, TypeVar, overload

T = TypeVar("T")


class Registry(Generic[T]):
    __slots__ = ("_items",)

    def __init__(self) -> None:
        self._items: dict[str, T] = {}

    def register(self, key: str, item: T) -> T:
        self._items[key] = item
        return item

    @overload
    def find(self, key: str) -> T | None: ...
    @overload
    def find(self, key: str, default: T) -> T: ...
    def find(self, key: str, default: T | None = None) -> T | None:
        return self._items.get(key, default)

    def __iter__(self) -> Iterator[T]:
        return iter(self._items.values())

    def __len__(self) -> int:
        return len(self._items)
