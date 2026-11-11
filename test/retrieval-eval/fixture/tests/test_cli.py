from click.testing import CliRunner

from taskboard.cli import main


def test_routes_lists_rules():
    result = CliRunner().invoke(main, ["routes"])
    assert "/tasks" in result.output


def test_init_db(tmp_path):
    result = CliRunner().invoke(main, ["init-db"])
    assert "Initialized" in result.output
