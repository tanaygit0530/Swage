from click.testing import CliRunner

from app.cli import cli


def test_routes():
    result = CliRunner().invoke(cli, ["routes"])
    assert "/tasks" in result.output


def test_config_masks_secrets():
    result = CliRunner().invoke(cli, ["config"])
    assert '"SECRET_KEY": "***"' in result.output
