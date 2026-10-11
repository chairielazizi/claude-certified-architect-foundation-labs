"""Tells the customer their refund is on its way."""
from src.notifications.email_gateway import EmailGateway

TEMPLATE = "refund_confirmation_v3"


class RefundNotifier:
    def __init__(self):
        self.email = EmailGateway()

    def send(self, order, charge):
        self.email.deliver(order.order_id, TEMPLATE, {"amount": charge["amount"]})
