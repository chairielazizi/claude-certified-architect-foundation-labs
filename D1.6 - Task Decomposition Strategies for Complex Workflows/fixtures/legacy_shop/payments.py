# criticality: high
"""Charges cards through the payment gateway and records the result."""
import requests

import db
from utils import money

GATEWAY_URL = "https://gateway.example.com/charge"


def charge(order_id, amount):
    response = requests.post(GATEWAY_URL, json={"order": order_id, "amount": money(amount)}, timeout=10)
    conn = db.connect()
    conn.execute("INSERT INTO payments VALUES (?, ?, ?)", (order_id, amount, response.status_code))
    return response.status_code == 200
