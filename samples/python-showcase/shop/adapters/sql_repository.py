"""Order repository backed by the fake session."""

from __future__ import annotations

from typing import Callable

from shop.domain import Order
from shop.domain.models import OrderStatus

from .session import Session


class SqlOrderRepository:
    """Implements ``OrderRepository`` structurally (no inheritance)."""

    def __init__(self, url: str, session_factory: Callable[[str], Session] = Session) -> None:
        self._url = url
        self._session_factory = session_factory
        self._cache: dict[str, Order] = {}

    def _session(self) -> Session:
        return self._session_factory(self._url)

    def save(self, order: Order) -> str:
        order_id = f"{order.customer}-{len(self._cache) + 1}"
        with self._session() as session:
            session.add(order_id, order)
        self._cache[order_id] = order
        return order_id

    def get(self, order_id: str) -> Order | None:
        if (cached := self._cache.get(order_id)) is not None:
            return cached
        with Session(self._url) as session:
            found = session.find(order_id)
        return found if isinstance(found, Order) else None

    def list_pending(self) -> list[Order]:
        return [order for order in self._cache.values() if order.status is OrderStatus.NEW]
