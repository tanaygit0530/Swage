// The panel states captured by `npm run screenshots:panel` (redesign step 8). Each state is the
// host messages the extension would send, plus optional clicks once they are rendered. The data
// is made up for the pictures (a Flask-like project); it holds no keys or personal details.

const models = {
  type: 'models',
  active: 'primary',
  autoFallback: true,
  items: [
    {
      name: 'primary',
      label: 'Gemini Flash Lite',
      model: 'google-gemini/gemini-flash-lite-latest',
    },
    { name: 'fallback-1', label: 'Groq GPT-OSS 120B', model: 'groq/openai-gpt-oss-120b' },
    { name: 'fallback-2', label: 'Ollama Qwen 2.5 7B', model: 'ollama/qwen2-5-7b' },
  ],
};
const init = [
  { type: 'init', workspace: 'flask', model: 'Gemini Flash Lite', mode: 'planning' },
  models,
];
const ask = {
  type: 'user',
  text: 'Add a `flask config` command that prints the app configuration as JSON with secrets masked. Test and document it.',
};
const running = { type: 'status', state: 'running', message: 'Running…' };
const budget = {
  type: 'budget',
  used: 9_840,
  total: 24_000,
  parts: [
    { label: 'request', tokens: 60 },
    { label: 'repo map', tokens: 3_100 },
    { label: 'file reads', tokens: 6_680 },
  ],
};

const tool = (id, name, summary, end) => [
  {
    type: 'tool_start',
    toolCallId: id,
    name,
    summary,
    args: JSON.stringify({ query: summary }, null, 2),
  },
  ...(end
    ? [
        {
          type: 'tool_end',
          toolCallId: id,
          durationMs: end.ms,
          resultChars: end.chars ?? 2400,
          error: false,
          ...(end.outcome ? { outcome: end.outcome } : {}),
        },
      ]
    : []),
];

const planFiles = [
  {
    path: 'src/flask/cli.py',
    reason: 'the built-in commands live here; config goes next to routes and shell',
  },
  { path: 'tests/test_cli.py', reason: 'CLI tests use CliRunner; add one for config' },
  { path: 'docs/cli.rst', reason: 'documents each built-in command' },
];
const planSteps = [
  'Add a `config` command to `FlaskGroup` that dumps `app.config` as JSON',
  'Mask keys that look secret (`SECRET_KEY`, `*_PASSWORD`, `*_TOKEN`)',
  'Test it with `CliRunner` and document it in `docs/cli.rst`',
];

const row = (path, kind, added, removed, decision, blocks) => ({
  path,
  kind,
  added,
  removed,
  decision,
  blocks,
});
const block = (id, state, added, removed, line, summary) => ({
  id,
  state,
  added,
  removed,
  line,
  summary,
});
const files = [
  row('src/flask/cli.py', 'modify', 41, 2, 'pending', [
    block('b1', 'pending', 3, 0, 12, 'import json'),
    block(
      'b2',
      'pending',
      38,
      2,
      1040,
      '@click.command("config", short_help="Show the app configuration.")',
    ),
  ]),
  row('tests/test_cli.py', 'modify', 24, 0, 'pending', [
    block('b1', 'pending', 24, 0, 690, 'def test_config_masks_secrets(runner):'),
  ]),
  row('docs/cli.rst', 'modify', 18, 0, 'pending', [
    block('b1', 'pending', 18, 0, 470, 'Show the Configuration'),
  ]),
  row('CHANGES.rst', 'modify', 2, 0, 'pending', [
    block('b1', 'pending', 2, 0, 9, '-   Add the ``flask config`` command.'),
  ]),
];
const edits = files.map((f) => ({
  type: 'edit',
  taskId: 't',
  path: f.path,
  kind: f.kind,
  added: f.added,
  removed: f.removed,
}));

const intro = [
  ...init,
  ask,
  running,
  budget,
  {
    type: 'text',
    messageId: 'm1',
    delta: "I'll find where the built-in commands are defined, then plan the change.",
  },
];
const discovery = [
  ...tool('t1', 'find_relevant_code', '"flask cli built-in commands routes shell"', {
    ms: 412,
    outcome: '8 results',
  }),
  ...tool('t2', 'read_files', 'src/flask/cli.py, tests/test_cli.py, docs/cli.rst', { ms: 96 }),
];
const finishedEdits = [
  { type: 'plan', steps: planSteps, files: planFiles },
  ...tool('t3', 'stage_edit', 'edit src/flask/cli.py', { ms: 38 }),
  ...tool('t4', 'stage_edit', 'edit tests/test_cli.py', { ms: 21 }),
  ...tool('t5', 'stage_edit', 'edit docs/cli.rst', { ms: 19 }),
  ...tool('t6', 'stage_edit', 'edit CHANGES.rst', { ms: 15 }),
  ...edits,
  ...tool('t7', 'run_tests', 'pytest tests/test_cli.py -q', { ms: 3_480, outcome: '62 passed' }),
];
const review = [
  {
    type: 'walkthrough',
    taskId: 't',
    summary:
      'Added **`flask config`**, which prints `app.config` as indented JSON. Values whose key looks secret are shown as `***`. A new test covers the masking, and the command is documented in `docs/cli.rst` and `CHANGES.rst`.',
    files: files.map(({ path, kind, added, removed }) => ({ path, kind, added, removed })),
  },
  { type: 'changes', phase: 'review', files },
  {
    type: 'turns',
    current: 't',
    latest: 't',
    items: [
      { taskId: 't', label: 'Add a flask config command', files: files.length, open: files.length },
    ],
  },
  {
    type: 'status',
    state: 'paused',
    message: 'Review the change set: accept or reject blocks, then Apply or Discard',
  },
];

export const STATES = {
  empty: { messages: [...init] },
  streaming: {
    messages: [
      ...intro,
      ...discovery,
      {
        type: 'text',
        messageId: 'm2',
        delta:
          'The commands are registered on `FlaskGroup` in `src/flask/cli.py:1040`. I will:\n\n1. add a **`config`** command next to `routes`\n2. mask secret values before printing\n3. cover it in `tests/test_cli.py`\n\n```python\n@click.command("config")\n@with_appcontext\ndef config_command() -> None:\n    ...',
      },
    ],
  },
  plan: {
    messages: [
      ...intro,
      ...discovery,
      { type: 'plan', steps: planSteps, files: planFiles, toolCallId: 'p1', awaiting: true },
      {
        type: 'status',
        state: 'paused',
        message: 'Review the plan: Approve it, or Edit it to send it back',
      },
    ],
  },
  'edited-files': {
    messages: [...intro, ...discovery, ...finishedEdits, ...review],
    scrollTo: '.edit-card',
    collapseBar: true,
  },
  'bar-collapsed': {
    messages: [...intro, ...discovery, ...finishedEdits, ...review],
    collapseBar: true,
  },
  'bar-expanded': {
    messages: [...intro, ...discovery, ...finishedEdits, ...review],
    click: ['[aria-label="Show the 2 change blocks of src/flask/cli.py"]'],
  },
  'turn-review': {
    messages: [
      ...intro,
      ...discovery,
      ...finishedEdits,
      {
        type: 'walkthrough',
        taskId: 't0',
        summary: 'Earlier turn: added a `--json` flag to `routes`.',
        files: [{ path: 'src/flask/cli.py', kind: 'modify', added: 9, removed: 1 }],
      },
      ...review,
      {
        type: 'turns',
        current: 't0',
        latest: 't',
        items: [
          { taskId: 't0', label: 'Add a --json flag to flask routes', files: 1, open: 1 },
          {
            taskId: 't',
            label: 'Add a flask config command',
            files: files.length,
            open: files.length,
          },
        ],
      },
      {
        type: 'changes',
        phase: 'review',
        files: [
          row('src/flask/cli.py', 'modify', 9, 1, 'pending', [
            block('b1', 'pending', 9, 1, 980, "@click.option('--json', is_flag=True)"),
          ]),
        ],
      },
    ],
    scrollTo: '.walkthrough',
  },
  'comment-chip': {
    messages: [
      ...intro,
      ...discovery,
      ...finishedEdits,
      ...review,
      {
        type: 'changes',
        phase: 'review',
        files: files.map((f, i) =>
          i === 3
            ? { ...f, settled: 'applied', decision: 'accepted' }
            : i === 1
              ? { ...f, decision: 'partial' }
              : f,
        ),
      },
      {
        type: 'comments',
        items: [
          { id: 'c1', path: 'src/flask/cli.py', lines: '1040-1042', text: 'Name it show-config' },
          { id: 'c2', path: 'tests/test_cli.py', lines: '690', text: 'Also test a nested dict' },
        ],
      },
    ],
    collapseBar: false,
  },
  approval: {
    messages: [
      ...intro,
      ...discovery,
      {
        type: 'approval',
        calls: [
          {
            toolCallId: 'c1',
            threadId: 'main',
            name: 'run_command',
            summary:
              'flask --app hello config\nReason: check that the new command prints masked JSON',
          },
        ],
      },
      { type: 'status', state: 'paused', message: 'Waiting for your approval' },
    ],
  },
  fallback: {
    messages: [
      ...intro,
      {
        type: 'notice',
        tone: 'warning',
        message:
          'Switched to Groq GPT-OSS 120B because Gemini Flash Lite returned 429 (rate limit). The task continues with the same plan and staged edits.',
        switchedFrom: 'primary',
      },
      { type: 'model', model: 'Groq GPT-OSS 120B (groq/openai-gpt-oss-120b)' },
      {
        ...models,
        active: 'fallback-1',
        items: models.items.map((m) =>
          m.name === 'primary' ? { ...m, note: 'returned 429 (rate limit)' } : m,
        ),
      },
      ...discovery,
      { type: 'recovered', name: 'primary', label: 'Gemini Flash Lite' },
    ],
  },
  cancelled: {
    messages: [
      ...intro,
      ...discovery,
      {
        type: 'tool_start',
        toolCallId: 't9',
        name: 'stage_edit',
        summary: 'edit src/flask/cli.py',
      },
      { type: 'status', state: 'cancelled', message: 'Cancelled. Workspace unchanged.' },
      { type: 'changes', phase: 'none', files: [] },
      { type: 'drained' },
    ],
  },
};
