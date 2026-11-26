"""HTTP handlers in a FastAPI-like style: route decorators and dependency injection."""

from __future__ import annotations

from typing import Annotated, Any, Callable

from shop.app import Application, create_app
from shop.services.order_service import OrderService

Handler = Callable[..., Any]


class Router:
    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Handler] = {}

    def route(self, method: str, path: str) -> Callable[[Handler], Handler]:
        def register(handler: Handler) -> Handler:
            self.routes[(method, path)] = handler
            return handler

        return register

    def get(self, path: str) -> Callable[[Handler], Handler]:
        return self.route("GET", path)

    def post(self, path: str) -> Callable[[Handler], Handler]:
        return self.route("POST", path)


def Depends(factory: Callable[[], Any]) -> Any:  # noqa: N802 - mirrors FastAPI
    return factory()


router = Router()
_app: Application | None = None


def get_app() -> Application:
    global _app
    if _app is None:
        _app = create_app()
    return _app


def get_service() -> OrderService:
    return get_app().service


@router.post("/orders")
def create_order(
    payload: dict[str, Any],
    service: Annotated[OrderService, Depends(get_service)],
) -> dict[str, Any]:
    order = service.place_order(payload["customer"], payload["items"])
    return {"summary": order.summary(), "pending": service.pending_count}


@router.get("/orders/report")
def report(app: Application = Depends(get_app)) -> str:
    return app.report()
