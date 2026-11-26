"""A fake database session, used as a context manager."""

from __future__ import annotations

from types import TracebackType


class Session:
    def __init__(self, url: str) -> None:
        self.url = url
        self.rows: dict[str, object] = {}
        self._open = False

    def __enter__(self) -> Session:
        self._open = True
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def add(self, key: str, row: object) -> None:
        self._ensure_open()
        self.rows[key] = row

    def find(self, key: str) -> object | None:
        self._ensure_open()
        return self.rows.get(key)

    def close(self) -> None:
        self._open = False

    def _ensure_open(self) -> None:
        if not self._open:
            raise RuntimeError("session closed")
