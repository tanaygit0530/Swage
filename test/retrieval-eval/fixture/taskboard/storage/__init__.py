"""Task store selection."""
from .memory import MemoryStore
from .sqlite import SqliteStore


def get_store(config):
    """Return the store named by the STORE setting."""
    if config.get("STORE") == "memory":
        return MemoryStore()
    return SqliteStore(config["DATABASE"])
