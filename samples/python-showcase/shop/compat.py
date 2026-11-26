"""Version-dependent definitions and optional dependencies."""

import sys

if sys.version_info >= (3, 11):

    def utc_now_iso() -> str:
        from datetime import UTC, datetime

        return datetime.now(UTC).isoformat()

else:

    def utc_now_iso() -> str:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).isoformat()


try:
    import orjson as _json
except ImportError:
    import json as _json


def dumps(data: object) -> str:
    """Serializes ``data``; ``_json.dumps`` is a library call, not this function."""
    result = _json.dumps(data)
    return result.decode() if isinstance(result, bytes) else result


def stamp(data: dict[str, object]) -> str:
    return dumps({**data, "at": utc_now_iso()})
