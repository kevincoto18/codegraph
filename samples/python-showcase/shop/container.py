"""Wires the application together (manual dependency injection)."""

from __future__ import annotations

from functools import cached_property

from shop.adapters.notifiers import CompositeNotifier, EmailNotifier, SmsNotifier
from shop.adapters.payments import FakeGateway, StripeGateway
from shop.adapters.sql_repository import SqlOrderRepository
from shop.config import Settings
from shop.domain.collections import Registry
from shop.ports import Notifier, PaymentGateway
from shop.services import OrderService
from shop.services.pricing import TEN_PERCENT, bulk_rule


class Container:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.repo = SqlOrderRepository(settings.database_url)
        self.notifier: Notifier = CompositeNotifier(
            EmailNotifier(settings.smtp_host),
            SmsNotifier(),
        )
        self.gateways: Registry[PaymentGateway] = Registry()

    @cached_property
    def payments(self) -> PaymentGateway:
        if (existing := self.gateways.find("default")) is not None:
            return existing
        if self.settings.database_url.startswith("sqlite"):
            return self.gateways.register("default", FakeGateway())
        return self.gateways.register("default", StripeGateway(api_key="sk_test"))

    def build_service(self) -> OrderService:
        rules = [TEN_PERCENT, bulk_rule(10)]
        return OrderService(self.repo, self.notifier, self.payments, rules)


def build_default() -> Container:
    return Container(Settings.from_env())
