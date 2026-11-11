from taskboard.models import Task
from taskboard.routes.tasks import create_task, list_tasks


def test_create_and_list(store):
    request = {"session": "s", "json": {"id": 1, "title": "Write docs"}}
    create_task(request, store)
    assert list_tasks({"session": "s"}, store)[0]["title"] == "Write docs"


def test_task_defaults():
    assert Task(id=1, title="x").done is False
