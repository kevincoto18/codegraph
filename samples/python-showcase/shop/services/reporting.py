"""Reports over stored orders."""

from __future__ import annotations

import shop.utils.text as text
from shop.domain import models as m
from shop.domain.models import OrderStatus

from ..ports import OrderRepository


def status_counts(repo: OrderRepository) -> dict[str, int]:
    counts: dict[str, int] = {}
    for order in repo.list_pending():
        label = order.status.label()
        counts[label] = counts.get(label, 0) + 1
    return counts


def describe(order: m.Order) -> str:
    match order.status:
        case OrderStatus.NEW:
            prefix = "new"
        case OrderStatus.PAID | OrderStatus.SHIPPED:
            prefix = order.status.label().lower()
        case _:
            prefix = "unknown"
    return f"[{prefix}] {text.slugify(order.customer)} {text.truncate(order.summary())}"


def daily_report(repo: OrderRepository) -> str:
    lines = [describe(order) for order in repo.list_pending()]
    if (count := len(lines)) == 0:
        return "no pending orders"
    header = m.Order.Meta.describe()
    return "\n".join([header, f"{count} pending", *lines])
