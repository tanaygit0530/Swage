import pytest

from taskboard import create_app


@pytest.fixture
def app():
    return create_app({"STORE": "memory", "TESTING": True})


@pytest.fixture
def store(app):
    return app.store
