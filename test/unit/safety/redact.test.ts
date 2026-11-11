import { describe, expect, it } from 'vitest';
import { redact, redactText, REDACTED_PREFIX } from '../../../src/safety/redact';

/**
 * Fake secrets are assembled at runtime so no key-shaped literal is ever committed
 * (CLAUDE.md: no keys in the repo or in tests).
 */
function fake(prefix: string, length: number, alphabet = 'Ab3Xy9Qz7Lm2Np5Rt8Kv4Wd6'): string {
  let body = '';
  while (body.length < length) body += alphabet;
  return prefix + body.slice(0, length);
}

const UPPER_DIGITS = 'QWERTYUIOP23456789ASDFGH';

const CASES: readonly { kind: string; secret: string; context: (s: string) => string }[] = [
  {
    kind: 'openai_key',
    secret: fake('sk-' + 'proj-', 48),
    context: (s) => `client = OpenAI(api_key=${s})`,
  },
  { kind: 'openai_key', secret: fake('sk-', 40), context: (s) => `key ${s} here` },
  { kind: 'anthropic_key', secret: fake('sk-' + 'ant-api03-', 60), context: (s) => `x ${s}` },
  { kind: 'groq_key', secret: fake('gs' + 'k_', 52), context: (s) => `GROQ ${s}` },
  { kind: 'google_api_key', secret: fake('AI' + 'za', 35), context: (s) => `url?key=${s}&q=1` },
  { kind: 'github_token', secret: fake('gh' + 'p_', 36), context: (s) => `token ${s}` },
  { kind: 'github_token', secret: fake('github' + '_pat_', 40), context: (s) => `${s}` },
  {
    kind: 'aws_access_key',
    secret: fake('AK' + 'IA', 16, UPPER_DIGITS),
    context: (s) => `aws ${s} end`,
  },
  { kind: 'slack_token', secret: fake('xo' + 'xb-', 30), context: (s) => `slack ${s}` },
  { kind: 'stripe_key', secret: fake('sk' + '_live_', 24), context: (s) => `stripe ${s}` },
  { kind: 'huggingface_token', secret: fake('h' + 'f_', 34), context: (s) => `hf ${s}` },
  {
    kind: 'npm_token',
    secret: fake('np' + 'm_', 36),
    context: (s) => `//registry/:_authToken ${s}`,
  },
  {
    kind: 'jwt',
    secret: `${fake('ey' + 'J', 20)}.${fake('ey' + 'J', 30)}.${fake('', 24)}`,
    context: (s) => `cookie=${s};`,
  },
];

describe('redact: provider keys and tokens', () => {
  for (const { kind, secret, context } of CASES) {
    it(`redacts ${kind} (${secret.slice(0, 4)}…)`, () => {
      const r = redact(context(secret));
      expect(r.text).not.toContain(secret);
      expect(r.text).toContain(`${REDACTED_PREFIX}${kind}]`);
      expect(r.kinds).toContain(kind);
      expect(r.count).toBeGreaterThanOrEqual(1);
    });
  }

  it('keeps the Bearer prefix and the URL user name', () => {
    const token = fake('', 32);
    expect(redactText(`Authorization: Bearer ${token}`)).toBe(
      `Authorization: Bearer ${REDACTED_PREFIX}bearer_token]`,
    );
    const pw = 'pa55' + 'word123';
    expect(redactText(`postgres://admin:${pw}@db.local:5432/app`)).toBe(
      `postgres://admin:${REDACTED_PREFIX}url_password]@db.local:5432/app`,
    );
  });

  it('redacts private key blocks, including truncated ones', () => {
    const body = fake('', 64) + '\n' + fake('', 64);
    const begin = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
    const end = '-----END ' + 'RSA PRIVATE KEY-----';
    const r = redact(`before\n${begin}\n${body}\n${end}\nafter`);
    expect(r.text).toBe(`before\n${REDACTED_PREFIX}private_key]\nafter`);

    const openssh = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
    const cut = redact(`${openssh}\n${body}`);
    expect(cut.text).toBe(`${REDACTED_PREFIX}private_key]`);
  });
});

describe('redact: password and secret assignments', () => {
  it('redacts quoted values and keeps the key and quotes', () => {
    const v = 'hunter' + '2-real';
    expect(redactText(`password = "${v}"`)).toBe(
      `password = "${REDACTED_PREFIX}password_assignment]"`,
    );
    expect(redactText(`app.config["SECRET_KEY"] = '${v}'`)).toBe(
      `app.config["SECRET_KEY"] = '${REDACTED_PREFIX}password_assignment]'`,
    );
    expect(redactText(`SECRET_KEY='${v}'`)).toBe(
      `SECRET_KEY='${REDACTED_PREFIX}password_assignment]'`,
    );
    expect(redactText(`{"api_key": "${v}", "name": "flask"}`)).toBe(
      `{"api_key": "${REDACTED_PREFIX}password_assignment]", "name": "flask"}`,
    );
    expect(redactText(`const apiKey = \`${v}\`;`)).toContain(
      `${REDACTED_PREFIX}password_assignment]`,
    );
    expect(redactText(`client_secret => "${v}"`)).toContain(REDACTED_PREFIX);
    expect(redactText(`db_password := "${v}"`)).toContain(REDACTED_PREFIX);
  });

  it('redacts env-file and YAML values that look like secrets', () => {
    const v = 'Zx81' + 'qQ9pLm';
    const env = redact(`# settings\nGROQ_API_KEY=${v}\nexport DB_PASSWORD=${v}\nDEBUG=1\n`);
    expect(env.text).not.toContain(v);
    expect(env.count).toBe(2);
    expect(env.text).toContain('DEBUG=1');
    expect(redactText(`  password: ${v}  # prod`)).toBe(
      `  password: ${REDACTED_PREFIX}password_assignment]  # prod`,
    );
  });

  it('leaves ordinary code and placeholders alone', () => {
    const untouched = [
      'SECRET_KEY = os.environ["SECRET_KEY"]',
      'app.secret_key = "dev"',
      'def check_password(password: str) -> bool:',
      '    token: str = ""',
      '    token: Token',
      '    password: Optional[str] = None',
      'tokenizer = "bert-base-uncased"',
      'PASSWORD_MIN_LENGTH = 8',
      'api_key = "<your-api-key>"',
      'API_KEY=${GROQ_API_KEY}',
      'token = "***"',
      'password = "changeme"',
      'secret = "{{ vault.secret }}"',
      'MASK_KEYS = ("SECRET", "PASSWORD", "TOKEN", "KEY")',
      'value = "***" if any(k in key for k in MASK_KEYS) else value',
      'password=hunter2',
      'Bearer short',
    ];
    for (const line of untouched) {
      expect(redactText(line), line).toBe(line);
    }
  });

  it('does not redact a value twice', () => {
    const key = fake('gs' + 'k_', 52);
    const r = redact(`GROQ_API_KEY="${key}"`);
    expect(r.text).toBe(`GROQ_API_KEY="${REDACTED_PREFIX}groq_key]"`);
    expect(r.count).toBe(1);
    expect(r.kinds).toEqual(['groq_key']);
  });

  it('counts several secrets in one text and returns sorted kinds', () => {
    const r = redact(
      `a ${fake('gh' + 'p_', 36)}\nb ${fake('sk-', 40)}\npassword = "${'s3cr' + 'et!!'}"`,
    );
    expect(r.count).toBe(3);
    expect(r.kinds).toEqual(['github_token', 'openai_key', 'password_assignment']);
  });

  it('returns text without secrets unchanged', () => {
    const src = 'def get_debug_flag() -> bool:\n    return bool(val)\n';
    expect(redact(src)).toEqual({ text: src, count: 0, kinds: [] });
  });
});
