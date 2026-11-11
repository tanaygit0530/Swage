"""Configuration loading."""
import os

DEFAULTS = {"DEBUG": False, "SECRET_KEY": None, "DATABASE": "demo.sqlite"}


def load_config():
    """Merge defaults with DEMO_* environment variables."""
    config = dict(DEFAULTS)
    for key in DEFAULTS:
        value = os.environ.get(f"DEMO_{key}")
        if value is not None:
            config[key] = value
    return config
