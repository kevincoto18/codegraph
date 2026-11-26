"""Tests with hand-written fakes that implement the ports structurally."""

from __future__ import annotations

import pytest

from shop.domain.models import Order
from shop.services.order_service import OrderService


class FakeRepository:
    def __init__(self) -> None:
        self.saved: list[Order] = []

    def save(self, order: Order) -> str:
        self.saved.append(order)
        return f"id-{len(self.saved)}"

    def get(self, order_id: str) -> Order | None:
        return None

    def list_pending(self) -> list[Order]:
        return list(self.saved)


class FakeNotifier:
    def __init__(self) -> None:
        self.messages: list[tuple[str, str]] = []

    def send(self, recipient: str, message: str) -> None:
        self.messages.append((recipient, message))


class FakeGateway:  # same name as the adapter, and not a PaymentGateway subclass
    def charge(self, customer: str, amount: object) -> str:
        return "paid"


@pytest.fixture
def service() -> OrderService:
    return OrderService(FakeRepository(), FakeNotifier(), FakeGateway())  # type: ignore[arg-type]


def test_place_order(service: OrderService) -> None:
    order = service.place_order("ada", [("book", 2, 10.0)])
    assert order.total().amount == 20.0
    assert service.pending_count == 1


def test_validation() -> None:
    with pytest.raises(ValueError):
        OrderService._validate("", [])
