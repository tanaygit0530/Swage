"""Outgoing webhooks for task events."""
import json
import time
import urllib.request

DEFAULT_TIMEOUT = 5


def build_payload(event, task):
    return json.dumps({"event": event, "task": {"id": task.id, "title": task.title}}).encode()


def post_webhook(url, event, task, retries=1):
    """POST a task event to the configured WEBHOOK_URL."""
    body = build_payload(event, task)
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT) as response:
                return response.status
        except OSError:
            if attempt == retries - 1:
                raise
            time.sleep(1)
