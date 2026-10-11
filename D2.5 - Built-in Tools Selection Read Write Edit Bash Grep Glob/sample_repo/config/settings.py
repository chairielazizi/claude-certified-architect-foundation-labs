"""Service settings. Note: the payments and refunds blocks share several identical lines."""

PAYMENTS = {
    "provider": "stripe",
    "timeout_seconds": 30,
    "max_retries": 3,
}

REFUNDS = {
    "window_days": 30,
    "timeout_seconds": 30,
    "max_retries": 3,
}
