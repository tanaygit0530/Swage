"""Application factory and error handlers."""
from .config import load_config
from .logging import configure_logging
from .routes import register_routes
from .storage import get_store


class Application:
    """Holds the configuration, the task store and the registered routes."""

    def __init__(self, config):
        self.config = config
        self.store = get_store(config)
        self.url_rules = []
        self.error_handlers = {}

    def add_url_rule(self, rule, endpoint, view, methods=("GET",)):
        self.url_rules.append((rule, endpoint, view, tuple(methods)))

    def errorhandler(self, code):
        def decorator(fn):
            self.error_handlers[code] = fn
            return fn

        return decorator


def create_app(overrides=None):
    """Create the application, applying configuration overrides for tests."""
    config = load_config(overrides)
    configure_logging(config)
    app = Application(config)
    register_routes(app)

    @app.errorhandler(404)
    def not_found(error):
        return {"error": "not found"}, 404

    return app
