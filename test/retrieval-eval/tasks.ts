/**
 * Hand-labelled retrieval tasks for the fixture project (blueprint section 7, gap G16).
 * Each task is phrased the way a user would ask, without naming files; `expected` lists
 * the files a correct change must touch.
 */
export interface EvalTask {
  readonly id: string;
  readonly query: string;
  readonly expected: readonly string[];
}

export const FIXTURE_TASKS: readonly EvalTask[] = [
  {
    id: 'config-command',
    query:
      'Add a new built-in command config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in the command help, be covered by a test, and be documented alongside the other built-in commands.',
    expected: ['taskboard/cli.py', 'tests/test_cli.py', 'docs/cli.md'],
  },
  {
    id: 'bool-env',
    query:
      "Treat 'off' and 'n' as false, case-insensitively, when reading boolean settings from the environment",
    expected: ['taskboard/config.py'],
  },
  {
    id: 'webhook-backoff',
    query:
      'Retry failed webhook deliveries with exponential backoff, up to five attempts, and test it',
    expected: ['taskboard/notifications/webhook.py', 'tests/test_webhook.py'],
  },
  {
    id: 'sort-priority',
    query: 'Let users sort the task list by priority in the web client',
    expected: ['web/src/components/TaskList.tsx', 'web/src/store.ts'],
  },
  {
    id: 'password-salt',
    query:
      'Hash passwords with a random per-user salt instead of a fixed one, and keep verification working',
    expected: ['taskboard/auth.py', 'tests/test_auth.py'],
  },
  {
    id: 'csv-export',
    query: 'Support exporting tasks as CSV with due date and priority columns',
    expected: ['taskboard/export.py', 'tests/test_export.py'],
  },
  {
    id: 'natural-dates',
    query: "Accept due dates written as 'tomorrow' or 'next week'",
    expected: ['taskboard/utils/dates.py', 'tests/test_dates.py'],
  },
  {
    id: 'paginate-tasks',
    query: 'Paginate the task listing endpoint using page and per_page query parameters',
    expected: ['taskboard/routes/tasks.py', 'taskboard/utils/pagination.py'],
  },
  {
    id: 'assign-email',
    query: 'Email the assignee when a task is assigned to them',
    expected: ['taskboard/notifications/email.py', 'taskboard/routes/tasks.py'],
  },
  {
    id: 'client-token',
    query:
      'Make the API client send the session token with every request and retry once after a 401',
    expected: ['web/src/api.ts'],
  },
  {
    id: 'relative-due',
    query: "Show due dates relative to today, such as 'in 3 days', in the task list",
    expected: ['web/src/utils/format.ts', 'web/src/components/TaskList.tsx'],
  },
  {
    id: 'sqlite-index',
    query: 'Add an index on the due column of the SQLite tasks table',
    expected: ['taskboard/storage/sqlite.py'],
  },
  {
    id: 'empty-title',
    query: 'Prevent creating a task with an empty title from the form',
    expected: ['web/src/components/TaskForm.tsx'],
  },
  {
    id: 'email-login',
    query: 'Allow logging in with an email address as well as a username',
    expected: ['taskboard/routes/users.py', 'taskboard/auth.py'],
  },
  {
    id: 'seed-command',
    query:
      'Add a command that seeds the database with example tasks for local development, and document it',
    expected: ['taskboard/cli.py', 'docs/cli.md'],
  },
  {
    id: 'json-logs',
    query: 'Emit logs as JSON lines when the LOG_FORMAT setting is json',
    expected: ['taskboard/logging.py', 'taskboard/config.py'],
  },
  {
    id: 'slug-accents',
    query: 'Transliterate accented characters when generating URL slugs from task titles',
    expected: ['taskboard/utils/slugify.py'],
  },
  {
    id: 'webhook-hmac',
    query:
      'Sign outgoing webhook payloads with an HMAC-SHA256 signature header using a shared secret',
    expected: ['taskboard/notifications/webhook.py'],
  },
  {
    id: 'document-settings',
    query: 'Document every configuration setting with its default value',
    expected: ['docs/configuration.md', 'taskboard/config.py'],
  },
  {
    id: 'json-405',
    query: 'Return a JSON error body for 405 Method Not Allowed responses',
    expected: ['taskboard/app.py'],
  },
];

/**
 * Labelled queries on Flask 3.1.3 (commit 22d92470), including the exact Task A and Task B
 * wording. Run only when SWAGE_FLASK_DIR points at that checkout.
 */
export const FLASK_TASKS: readonly EvalTask[] = [
  {
    id: 'task-b',
    query:
      'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.',
    expected: ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst'],
  },
  {
    id: 'task-a',
    query:
      "In get_debug_flag, treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.",
    expected: ['src/flask/helpers.py'],
  },
  {
    id: 'reloader-exclude',
    query: 'Let flask run read extra reloader exclude patterns from an environment variable',
    expected: ['src/flask/cli.py'],
  },
  {
    id: 'json-sort-keys',
    query: 'Sort keys in JSON responses only when a new config option is enabled',
    expected: ['src/flask/json/provider.py'],
  },
  {
    id: 'session-key-rotation',
    query: 'Rotate the secret key used to sign the session cookie with a list of fallback keys',
    expected: ['src/flask/sessions.py'],
  },
  {
    id: 'config-toml',
    query: 'Add a Config method that loads settings from a TOML file, with tests',
    expected: ['src/flask/config.py', 'tests/test_config.py'],
  },
  {
    id: 'stream-signal',
    query: 'Pass extra context to the template_rendered signal when streaming a template',
    expected: ['src/flask/templating.py'],
  },
  {
    id: 'test-client-cookies',
    query: 'The test client should keep cookies between requests when following redirects',
    expected: ['src/flask/testing.py'],
  },
  {
    id: 'blueprint-twice',
    query: 'Allow registering the same blueprint twice under a different name and url_prefix',
    expected: ['src/flask/sansio/blueprints.py'],
  },
  {
    id: 'log-format',
    query: "Change the default log format of the app logger's handler",
    expected: ['src/flask/logging.py'],
  },
  {
    id: 'ctx-pop-order',
    query: 'Raise a clearer error when the application context is popped in the wrong order',
    expected: ['src/flask/ctx.py'],
  },
];
