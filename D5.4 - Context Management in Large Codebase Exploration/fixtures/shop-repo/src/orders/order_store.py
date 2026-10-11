"""Reads orders from the orders database."""
from dataclasses import dataclass


@dataclass
class Order:
    order_id: str
    charge_id: str
    total_cents: int
    delivered_on: object


class OrderStore:
    def get(self, order_id):
        raise NotImplementedError("database access is out of scope for the fixture")
