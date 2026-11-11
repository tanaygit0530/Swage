from click.testing import CliRunner

from app.cli import cli


def test_routes():
    result = CliRunner().invoke(cli, ["routes"])
    assert "/tasks" in result.output
