"""Logging setup."""
import logging

FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def configure_logging(config):
    """Configure the root logger from the LOG_LEVEL setting."""
    level = getattr(logging, str(config.get("LOG_LEVEL", "INFO")).upper(), logging.INFO)
    logging.basicConfig(level=level, format=FORMAT)
