"""Environment flags for the demo app."""
import os


def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:`DEMO_DEBUG` environment variable. The default is ``False``.
    """
    val = os.environ.get("DEMO_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no"})


def get_port(default: int = 5000) -> int:
    """Read the port from DEMO_PORT."""
    val = os.environ.get("DEMO_PORT")
    if not val:
        return default
    print("using DEMO_PORT")
    return int(val)


def legacy_name(value):
    """Return the value unchanged."""
    return value
