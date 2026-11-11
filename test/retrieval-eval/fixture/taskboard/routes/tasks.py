"""Task endpoints: list, create, update, assign and delete."""
from ..auth import login_required
from ..models import Priority, Task


def register(app):
    app.add_url_rule("/tasks", "list_tasks", list_tasks)
    app.add_url_rule("/tasks", "create_task", create_task, methods=["POST"])
    app.add_url_rule("/tasks/<int:task_id>", "update_task", update_task, methods=["PATCH"])
    app.add_url_rule("/tasks/<int:task_id>/assign", "assign_task", assign_task, methods=["POST"])
    app.add_url_rule("/tasks/<int:task_id>", "delete_task", delete_task, methods=["DELETE"])


@login_required
def list_tasks(request, store):
    """Return every task as JSON."""
    return [vars(t) for t in store.list_tasks()]


@login_required
def create_task(request, store):
    data = request["json"]
    task = Task(id=data["id"], title=data["title"], priority=Priority[data.get("priority", "NORMAL")])
    store.save_task(task)
    return vars(task), 201


@login_required
def update_task(request, store, task_id):
    task = store.tasks[task_id]
    for key, value in request["json"].items():
        setattr(task, key, value)
    store.save_task(task)
    return vars(task)


@login_required
def assign_task(request, store, task_id):
    """Assign a task to a user."""
    task = store.tasks[task_id]
    task.assignee_id = request["json"]["user_id"]
    store.save_task(task)
    return vars(task)


@login_required
def delete_task(request, store, task_id):
    store.delete_task(task_id)
    return "", 204
