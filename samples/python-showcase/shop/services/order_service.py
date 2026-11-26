"""Placing and paying orders."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from shop.domain import Order, OrderPlaced, publish
from shop.ports import Notifier, OrderRepository, PaymentGateway
from shop.utils import retry, timed

from . import pricing
from .pricing import DiscountRule

if TYPE_CHECKING:
    from shop.container import Container


class OrderService:
    """Coordinates repositories, payments and notifications."""

    def __init__(
        self,
        repo: OrderRepository,
        notifier: Notifier,
        payments: PaymentGateway,
        rules: list[DiscountRule] | None = None,
    ) -> None:
        self.repo = repo
        self.notifier = notifier
        self._payments = payments
        self._rules = rules or []

    @classmethod
    def create(cls, container: Container) -> OrderService:
        return cls(container.repo, container.notifier, container.payments)

    @staticmethod
    def _validate(customer: str, items: list[tuple[str, int, float]]) -> None:
        if not customer or not items:
            raise ValueError("an order needs a customer and items")

    @property
    def pending_count(self) -> int:
        return len(self.repo.list_pending())

    @timed
    def place_order(self, customer: str, items: list[tuple[str, int, float]]) -> Order:
        OrderService._validate(customer, items)
        order = Order(customer)
        for sku, quantity, price in items:
            order.add_line(sku, quantity, price)
        order.lines = pricing.apply_discounts(order.lines, self._rules)
        order_id = self.repo.save(order)
        self._charge(order, order_id)
        self.notifier.send(customer, order.summary())
        publish(OrderPlaced(order_id, order.total().amount))
        return order

    @retry(times=2)
    def _charge(self, order: Order, order_id: str) -> str:
        return self._payments.charge(order.customer, order.total())

    async def place_order_async(self, customer: str, items: list[tuple[str, int, float]]) -> Order:
        await self._reserve_stock(items)
        return await asyncio.to_thread(self.place_order, customer, items)

    async def _reserve_stock(self, items: list[tuple[str, int, float]]) -> None:
        await asyncio.sleep(0)
