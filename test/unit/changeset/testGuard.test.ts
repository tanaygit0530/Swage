import { describe, expect, it } from 'vitest';
import { collectedTests, isTestFile, lostTests } from '../../../src/changeset/testGuard';

const BEFORE = `import json


def test_top():
    assert True


class TestRoutes:
    def test_sort(self, invoke):
        match_order = [1]
        assert match_order

    def test_all_methods(self, invoke):
        def helper():
            pass
        assert invoke


class Helper:
    def test_not_collected(self):
        pass
`;

// What the rehearsal's agent did: a new function inside the class cut test_sort short and
// nested test_all_methods inside it.
const BROKEN = `import json


def test_top():
    assert True


class TestRoutes:
    def test_sort(self, invoke):


def test_config_command(app, runner):
    assert True

    def test_all_methods(self, invoke):
        assert invoke
`;

describe('test guard', () => {
  it('knows test files', () => {
    expect(isTestFile('tests/test_cli.py')).toBe(true);
    expect(isTestFile('pkg/cli_test.py')).toBe(true);
    expect(isTestFile('src/app.test.ts')).toBe(true);
    expect(isTestFile('web/a.spec.jsx')).toBe(true);
    expect(isTestFile('src/flask/cli.py')).toBe(false);
    expect(collectedTests('src/flask/cli.py', 'def test_x(): pass')).toBeUndefined();
  });

  it('collects pytest functions and Test* class methods, not nested helpers or other classes', () => {
    expect(collectedTests('tests/test_cli.py', BEFORE)).toEqual([
      'test_top',
      'TestRoutes.test_sort',
      'TestRoutes.test_all_methods',
    ]);
  });

  it('reports the tests a broken insertion loses, and none for a clean append', () => {
    expect(lostTests('tests/test_cli.py', BEFORE, BROKEN)).toEqual(['TestRoutes.test_all_methods']);
    const appended = `${BEFORE}\n\ndef test_config_command(app):\n    assert True\n`;
    expect(lostTests('tests/test_cli.py', BEFORE, appended)).toEqual([]);
    expect(lostTests('tests/test_cli.py', BEFORE, undefined)).toHaveLength(3);
    expect(lostTests('tests/test_cli.py', undefined, BEFORE)).toEqual([]);
    expect(lostTests('src/flask/cli.py', BEFORE, '')).toEqual([]);
  });

  it('collects it() and test() titles in JavaScript and TypeScript', () => {
    const before =
      "describe('x', () => {\n  it('adds', () => {});\n  test.only(\"subtracts\", () => {});\n});\n";
    expect(collectedTests('a.test.ts', before)).toEqual(['adds', 'subtracts']);
    expect(lostTests('a.test.ts', before, "it('adds', () => {});")).toEqual(['subtracts']);
  });
});
