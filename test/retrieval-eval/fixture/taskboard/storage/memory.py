"""In-memory store used by tests."""


class MemoryStore:
    def __init__(self):
        self.tasks = {}
        self.users = {}

    def migrate(self):
        pass

    def save_task(self, task):
        self.tasks[task.id] = task

    def list_tasks(self, limit=None, offset=0):
        items = sorted(self.tasks.values(), key=lambda t: t.id)
        return items[offset : None if limit is None else offset + limit]

    def delete_task(self, task_id):
        self.tasks.pop(task_id, None)
