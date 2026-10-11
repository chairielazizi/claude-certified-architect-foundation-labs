import logging

log = logging.getLogger(__name__)
_subscribers = {}


def subscribe(topic, handler):
    _subscribers.setdefault(topic, []).append(handler)


def publish(topic, payload):
    for handler in _subscribers.get(topic, []):
        try:
            handler(payload)
        except Exception:
            log.warning("handler failed for %s", topic)
