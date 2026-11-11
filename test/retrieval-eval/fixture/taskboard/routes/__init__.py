"""URL rule registration."""
from . import tasks, users


def register_routes(app):
    tasks.register(app)
    users.register(app)
