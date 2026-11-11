"""Due date parsing and human-friendly deltas."""
from datetime import datetime, timedelta, timezone


def parse_due_date(text, now=None):
    """Parse an ISO date such as 2026-11-20 or the word 'today'."""
    now = now or datetime.now(timezone.utc)
    text = text.strip().lower()
    if text == "today":
        return now.replace(hour=23, minute=59, second=0, microsecond=0)
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


def humanize_delta(due, now=None):
    """Describe how far away a due date is, for example 'overdue by 2 days'."""
    now = now or datetime.now(timezone.utc)
    days = (due - now) // timedelta(days=1)
    if days < 0:
        return f"overdue by {-days} days"
    return f"due in {days} days"
