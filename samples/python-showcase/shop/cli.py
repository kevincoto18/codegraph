"""Command line interface."""

from __future__ import annotations

import argparse
import sys
from typing import Sequence

from shop import create_app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="shop")
    sub = parser.add_subparsers(dest="command", required=True)
    order = sub.add_parser("order")
    order.add_argument("customer")
    order.add_argument("items", nargs="+")
    sub.add_parser("report")
    return parser


def parse_item(raw: str) -> tuple[str, int, float]:
    sku, quantity, price = raw.split(":")
    return sku, int(quantity), float(price)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    app = create_app()
    if args.command == "order":
        items = list(map(parse_item, args.items))
        print(app(args.customer, items))
    else:
        from shop.services.reporting import daily_report

        print(daily_report(app.container.repo))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
