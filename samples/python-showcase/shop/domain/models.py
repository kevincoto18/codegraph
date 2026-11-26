"""Orders, lines and money."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Iterator, NamedTuple


class Money(NamedTuple):
    """An amount in a currency."""

    amount: float
    currency: str = "USD"

    def __add__(self, other: Money) -> Money:
        _check_same_currency(self, other)
        return Money(self.amount + other.amount, self.currency)

    def scaled(self, factor: float) -> Money:
        return Money(round(self.amount * factor, 2), self.currency)


def _check_same_currency(left: Money, right: Money) -> None:
    if left.currency != right.currency:
        raise ValueError("currency mismatch")


class OrderStatus(Enum):
    NEW = "new"
    PAID = "paid"
    SHIPPED = "shipped"

    def label(self) -> str:
        return self.value.title()

    @property
    def is_final(self) -> bool:
        return self is OrderStatus.SHIPPED


@dataclass
class OrderLine:
    sku: str
    quantity: int
    unit_price: Money

    def subtotal(self) -> Money:
        return self.unit_price.scaled(self.quantity)


@dataclass
class Order:
    customer: str
    lines: list[OrderLine] = field(default_factory=list)
    status: OrderStatus = OrderStatus.NEW

    class Meta:
        table = "orders"

        @staticmethod
        def describe() -> str:
            return f"table {Order.Meta.table}"

    def add_line(self, sku: str, quantity: int, price: float) -> OrderLine:
        line = OrderLine(sku, quantity, Money(price))
        self.lines.append(line)
        return line

    def total(self) -> Money:
        amount = Money(0.0)
        for line in self.lines:
            amount = amount + line.subtotal()
        return amount

    def __iter__(self) -> Iterator[OrderLine]:
        return iter(self.lines)

    def summary(self) -> str:
        return f"{self.customer}: {self.status.label()} {self.total().amount}"
