"""Notifiers: email, SMS and a composite of several."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


class LoggingMixin:
    def log(self, message: str) -> None:
        logger.info("%s: %s", type(self).__name__, message)


class EmailNotifier(LoggingMixin):
    def __init__(self, host: str = "localhost") -> None:
        self.host = host
        self.sent: list[str] = []

    def send(self, recipient: str, message: str) -> None:
        body = self._format(recipient, message)
        self.sent.append(body)
        self.log(f"email to {recipient}")

    def _format(self, recipient: str, message: str) -> str:
        return f"To: {recipient}\n\n{message}"


class SmsNotifier(EmailNotifier):
    def __init__(self, host: str = "sms-gateway", max_length: int = 160) -> None:
        super().__init__(host)
        self.max_length = max_length

    def send(self, recipient: str, message: str) -> None:
        super().send(recipient, self._shorten(message))

    def _shorten(self, message: str) -> str:
        return message[: self.max_length]


class CompositeNotifier:
    def __init__(self, *notifiers: EmailNotifier) -> None:
        self._notifiers = notifiers

    def send(self, recipient: str, message: str) -> None:
        for notifier in self._notifiers:
            notifier.send(recipient, message)
