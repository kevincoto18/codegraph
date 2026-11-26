"""Domain events and a tiny in-process bus."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Callable

__all__ = ["OrderPlaced", "publish", "subscribe"]


@dataclass(frozen=True)
class OrderPlaced:
    order_id: str
    total: float


Handler = Callable[[OrderPlaced], None]
_HANDLERS: dict[str, list[Handler]] = defaultdict(list)


def subscribe(event_name: str, handler: Handler) -> None:
    _HANDLERS[event_name].append(handler)


def publish(event: OrderPlaced) -> int:
    return _dispatch(type(event).__name__, event)


def _dispatch(name: str, event: OrderPlaced) -> int:
    handlers = _HANDLERS.get(name, [])
    for handler in handlers:
        handler(event)
    return len(handlers)
