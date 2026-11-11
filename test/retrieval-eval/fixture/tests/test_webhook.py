from taskboard.models import Task
from taskboard.notifications.webhook import build_payload


def test_payload_contains_event():
    body = build_payload("created", Task(id=3, title="Ship"))
    assert b'"event": "created"' in body
