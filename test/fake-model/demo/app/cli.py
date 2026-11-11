"""Command line interface for the demo app."""
import click

from .config import load_config


@click.group()
def cli():
    """Demo app commands."""


@cli.command("routes")
def routes_command():
    """Show the registered routes."""
    click.echo("/ /tasks /users")


@cli.command("config")
def config_command():
    """Print the configuration as JSON, masking secret values."""
    import json

    config = load_config()
    masked = {
        key: "***" if any(word in key.upper() for word in ("SECRET", "PASSWORD", "TOKEN", "KEY")) else value
        for key, value in config.items()
    }
    click.echo(json.dumps(masked, default=str))
