"""Text helpers."""

import re
import unicodedata

_SPACES = re.compile(r"[^a-z0-9]+")


def slugify(value: str) -> str:
    """Turns ``value`` into a URL-friendly slug."""
    return _SPACES.sub("-", _normalize(value)).strip("-")


def _normalize(value: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return ascii_text.lower()


def truncate(value: str, length: int = 20) -> str:
    return value if len(value) <= length else value[: length - 1] + "…"
