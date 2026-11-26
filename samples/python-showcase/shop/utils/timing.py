"""Decorators for timing and retries."""

from __future__ import annotations

import functools
import time
from typing import Callable, ParamSpec, TypeVar

P = ParamSpec("P")
R = TypeVar("R")


def timed(fn: Callable[P, R]) -> Callable[P, R]:
    """Logs how long ``fn`` takes."""

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        started = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            _report(fn.__name__, time.perf_counter() - started)

    return wrapper


def retry(times: int = 3) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Retries ``fn`` up to ``times`` times (a decorator factory)."""

    def decorate(fn: Callable[P, R]) -> Callable[P, R]:
        @functools.wraps(fn)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            for attempt in range(times):
                try:
                    return fn(*args, **kwargs)
                except RuntimeError:
                    _report(f"retry {attempt + 1}", 0.0)
            return fn(*args, **kwargs)

        return wrapper

    return decorate


def _report(label: str, seconds: float) -> None:
    print(f"{label}: {seconds:.3f}s")
