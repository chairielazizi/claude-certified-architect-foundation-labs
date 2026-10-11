"""HTTP handlers for order lookups."""
from src.orders.order_store import OrderStore


def get_order(request, order_id):
    return OrderStore().get(order_id)
