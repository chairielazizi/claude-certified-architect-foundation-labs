import logging

log = logging.getLogger(__name__)


def record(action, sku, qty, sink):
    try:
        sink.write(f"{action},{sku},{qty}\n")
    except Exception:
        log.warning("audit write failed for %s", sku)
