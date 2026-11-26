"""Payment gateways (subclasses of the ``PaymentGateway`` ABC)."""

from __future__ import annotations

import uuid

from shop.domain.models import Money
from shop.ports import PaymentGateway


class StripeGateway(PaymentGateway):
    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def charge(self, customer: str, amount: Money) -> str:
        payload = self._payload(customer, amount)
        return self._request("/charges", payload)

    def _payload(self, customer: str, amount: Money) -> dict[str, object]:
        return {"customer": customer, "amount": amount.amount, "currency": amount.currency}

    def _request(self, path: str, payload: dict[str, object]) -> str:
        self._log(f"POST {path}")
        return str(uuid.uuid4())


class FakeGateway(PaymentGateway):
    def __init__(self) -> None:
        self.charges: list[tuple[str, Money]] = []

    def charge(self, customer: str, amount: Money) -> str:
        self.charges.append((customer, amount))
        return f"fake-{len(self.charges)}"
