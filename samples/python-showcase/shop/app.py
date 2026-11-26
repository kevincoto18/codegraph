"""Application object."""

from __future__ import annotations

from .compat import stamp
from .config import Settings, load_settings
from .container import Container
from .services.reporting import daily_report


class Application:
    def __init__(self, container: Container) -> None:
        self.container = container
        self.service = container.build_service()

    def __call__(self, customer: str, items: list[tuple[str, int, float]]) -> str:
        order = self.service.place_order(customer, items)
        return order.summary()

    def report(self) -> str:
        return stamp({"report": daily_report(self.container.repo)})


def create_app(settings: Settings | None = None) -> Application:
    container = Container(settings or load_settings())
    return Application(container)
