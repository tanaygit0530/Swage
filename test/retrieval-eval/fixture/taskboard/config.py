"""Configuration loading from defaults, an env file and environment variables."""
import os

DEFAULTS = {
    "DATABASE": "instance/taskboard.sqlite",
    "STORE": "sqlite",
    "SECRET_KEY": None,
    "SMTP_HOST": "localhost",
    "SMTP_PORT": 25,
    "WEBHOOK_URL": None,
    "LOG_LEVEL": "INFO",
    "DEBUG": False,
}

FALSE_VALUES = {"0", "false", "no"}


class Config(dict):
    """A dict of settings with attribute access."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


def parse_bool(value):
    """Interpret an environment variable as a boolean flag."""
    return bool(value) and value.lower() not in FALSE_VALUES


def read_env_file(path):
    """Read KEY=VALUE lines from an env file, ignoring comments."""
    values = {}
    if not path or not os.path.exists(path):
        return values
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    return values


def load_config(overrides=None):
    """Merge defaults, the env file and TASKBOARD_* environment variables."""
    overrides = overrides or {}
    config = Config(DEFAULTS)
    config.update(read_env_file(overrides.get("ENV_FILE")))
    for key in DEFAULTS:
        env_value = os.environ.get(f"TASKBOARD_{key}")
        if env_value is not None:
            config[key] = env_value
    config["DEBUG"] = parse_bool(str(config["DEBUG"]))
    config.update(overrides)
    return config
