"""SQLite persistence for tasks and users."""
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    priority INTEGER,
    due TEXT,
    assignee_id INTEGER,
    done INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT
);
"""


class SqliteStore:
    """Stores tasks in a SQLite database file."""

    def __init__(self, path):
        self.path = path
        self._conn = None

    def connect(self):
        if self._conn is None:
            self._conn = sqlite3.connect(self.path)
            self._conn.row_factory = sqlite3.Row
        return self._conn

    def migrate(self):
        self.connect().executescript(SCHEMA)

    def save_task(self, task):
        self.connect().execute(
            "INSERT OR REPLACE INTO tasks (id, title, description, priority, due, assignee_id, done)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (task.id, task.title, task.description, task.priority.value, task.due, task.assignee_id, task.done),
        )

    def list_tasks(self, limit=None, offset=0):
        sql = "SELECT * FROM tasks ORDER BY id"
        if limit is not None:
            sql += f" LIMIT {int(limit)} OFFSET {int(offset)}"
        return self.connect().execute(sql).fetchall()

    def delete_task(self, task_id):
        self.connect().execute("DELETE FROM tasks WHERE id = ?", (task_id,))
