import io
import json

from taskboard.export import export_json
from taskboard.models import Task


def test_export_json():
    buffer = io.StringIO()
    export_json([Task(id=1, title="a")], buffer)
    assert json.loads(buffer.getvalue())[0]["title"] == "a"
