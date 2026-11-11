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
