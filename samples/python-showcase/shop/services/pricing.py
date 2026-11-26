"""Discount rules and price calculations."""

from __future__ import annotations

from functools import partial, reduce
from typing import Callable, Iterable, Iterator

from shop.domain.models import Money, OrderLine

DiscountRule = Callable[[OrderLine], OrderLine]


def percent_off(line: OrderLine, rate: float) -> OrderLine:
    return OrderLine(line.sku, line.quantity, line.unit_price.scaled(1 - rate))


def bulk_rule(min_quantity: int) -> DiscountRule:
    """Builds a rule that discounts lines with many units (a closure)."""

    def rule(line: OrderLine) -> OrderLine:
        if line.quantity >= min_quantity:
            return percent_off(line, 0.05)
        return line

    return rule


TEN_PERCENT: DiscountRule = partial(percent_off, rate=0.10)
round_price = lambda money: Money(round(money.amount, 2), money.currency)  # noqa: E731


def line_key(line: OrderLine) -> float:
    return line.subtotal().amount


def apply_discounts(lines: Iterable[OrderLine], rules: list[DiscountRule]) -> list[OrderLine]:
    """Applies every rule to every line, most expensive lines first."""
    ordered = sorted(lines, key=line_key, reverse=True)
    return [reduce(lambda current, rule: rule(current), rules, line) for line in ordered]


def iter_prices(lines: Iterable[OrderLine]) -> Iterator[Money]:
    for line in lines:
        yield round_price(line.subtotal())


def cheapest(lines: list[OrderLine]) -> OrderLine | None:
    return min(lines, key=lambda line: line.subtotal().amount, default=None)
