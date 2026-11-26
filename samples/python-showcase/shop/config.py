"""Settings loaded from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    """Application settings."""

    database_url: str = "sqlite://"
    smtp_host: str = "localhost"
    currency: str = "USD"
    tags: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_env(cls) -> Settings:
        """Reads the settings from environment variables."""
        return cls(
            database_url=_read("DATABASE_URL", "sqlite://"),
            smtp_host=_read("SMTP_HOST", "localhost"),
        )

    def with_currency(self, currency: str) -> Settings:
        """Returns a copy using another currency."""
        return Settings(self.database_url, self.smtp_host, currency)


def _read(name: str, default: str) -> str:
    return os.environ.get(name, default)


def load_settings() -> Settings:
    """Loads the settings from the environment."""
    return Settings.from_env()
