"""Ports: what the services need from the outside world."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from shop.domain.models import Money, Order


@runtime_checkable
class OrderRepository(Protocol):
    """Stores orders."""

    def save(self, order: Order) -> str: ...

    def get(self, order_id: str) -> Order | None: ...

    def list_pending(self) -> list[Order]: ...


class Notifier(Protocol):
    def send(self, recipient: str, message: str) -> None: ...


class PaymentGateway(ABC):
    """Charges customers."""

    @abstractmethod
    def charge(self, customer: str, amount: Money) -> str:
        """Charges an amount and returns the payment id."""

    def refund(self, payment_id: str) -> None:
        self._log(f"refund {payment_id}")

    def _log(self, message: str) -> None:
        print(message)
