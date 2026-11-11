from datetime import datetime, timezone

from taskboard.utils.dates import humanize_delta, parse_due_date

NOW = datetime(2026, 11, 11, tzinfo=timezone.utc)


def test_parse_iso_and_today():
    assert parse_due_date("2026-11-20", NOW).day == 20
    assert parse_due_date("today", NOW).day == 11


def test_humanize_overdue():
    assert humanize_delta(datetime(2026, 11, 9, tzinfo=timezone.utc), NOW) == "overdue by 2 days"
