"""Command-line entry point for the shop backend."""

import sys

from app.checkout import checkout_cart


def main(argv: list[str]) -> int:
    cart_id = argv[1] if len(argv) > 1 else "cart-demo"
    receipt = checkout_cart(cart_id)
    print(receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
