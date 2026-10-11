"""HTTP handler for refund requests."""
from src.payments.credit_reversal import CreditReversalService


def post_refund(request):
    body = request.json()
    return CreditReversalService().reverse(body["order_id"], body["reason"])
