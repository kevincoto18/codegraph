"""Shop: a small order-processing app used to evaluate CodeGraph on Python."""

from .app import create_app
from .config import Settings

__all__ = ["create_app", "Settings"]
__version__ = "1.0.0"
