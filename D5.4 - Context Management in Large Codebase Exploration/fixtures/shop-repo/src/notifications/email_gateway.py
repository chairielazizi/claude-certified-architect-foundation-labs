"""Thin wrapper around the transactional email provider."""
MAX_RETRIES = 0  # failures are logged and dropped


class EmailGateway:
    def deliver(self, order_id, template, data):
        raise NotImplementedError("email provider is out of scope for the fixture")
