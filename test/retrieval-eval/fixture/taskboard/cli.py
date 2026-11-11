"""Command line interface built on click."""
import click

from .app import create_app
from .storage import get_store


@click.group()
@click.option("--env-file", default=".env", help="Load settings from this file.")
@click.pass_context
def main(ctx, env_file):
    """Manage the taskboard application."""
    ctx.obj = create_app({"ENV_FILE": env_file})


@main.command("run")
@click.option("--port", default=8000, show_default=True)
@click.pass_obj
def run_command(app, port):
    """Start the development server."""
    click.echo(f"Serving taskboard on http://127.0.0.1:{port}")


@main.command("routes")
@click.pass_obj
def routes_command(app):
    """Show every registered URL rule with its endpoint and methods."""
    for rule, endpoint, _view, methods in sorted(app.url_rules):
        click.echo(f"{rule:30} {endpoint:20} {','.join(methods)}")


@main.command("init-db")
@click.pass_obj
def init_db_command(app):
    """Create the database tables."""
    get_store(app.config).migrate()
    click.echo("Initialized the database.")
