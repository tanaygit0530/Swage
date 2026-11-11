"""Export tasks to JSON."""
import json


def task_to_dict(task):
    return {"id": task.id, "title": task.title, "done": task.done}


def export_json(tasks, fh):
    """Write tasks as a JSON array."""
    json.dump([task_to_dict(t) for t in tasks], fh, indent=2)
