# criticality: high
"""Order placement: price the cart, charge the customer, record the order."""
from datetime import datetime

import db
import models
import notifications
import payments
from pricing import bulk_discount, line_total
from utils import money


def place_order(customer_id, items):
    customer = models.get_customer(customer_id)
    subtotal = sum(line_total(i["price"], i["qty"]) * (1 - bulk_discount(i["qty"])) for i in items)
    order_id = f"ORD-{datetime.now():%Y%m%d%H%M%S}"
    if not payments.charge(order_id, subtotal):
        raise RuntimeError("payment declined")
    db.connect().execute("INSERT INTO orders VALUES (?, ?, ?)", (order_id, customer_id, money(subtotal)))
    notifications.send_confirmation(customer, order_id)
    return order_id
