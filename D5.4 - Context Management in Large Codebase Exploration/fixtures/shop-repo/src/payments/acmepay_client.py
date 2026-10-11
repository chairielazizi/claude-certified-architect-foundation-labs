"""Client for the AcmePay payment service provider."""
import json
import urllib.request

ACMEPAY_BASE_URL = "https://api.acmepay.example/v2"
TIMEOUT_SECONDS = 10


class AcmePayClient:
    def refund(self, charge_id, amount_cents):
        payload = json.dumps({"charge": charge_id, "amount": amount_cents}).encode()
        req = urllib.request.Request(f"{ACMEPAY_BASE_URL}/refunds", data=payload, method="POST")
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read())
