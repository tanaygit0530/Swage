/**
 * Redacts secrets from any text before it leaves the extension (blueprint sections 6 and 7):
 * provider API keys, tokens, private keys, credentials in URLs and password-style
 * assignments. Over-redaction is safer than a leak, but ordinary code such as
 * `SECRET_KEY = os.environ["SECRET_KEY"]` or `token: str` is left alone so the agent can
 * still anchor edits on it.
 */

export interface RedactionResult {
  readonly text: string;
  /** Number of secrets replaced. */
  readonly count: number;
  /** Kinds of secrets found, sorted and unique. */
  readonly kinds: readonly string[];
}

export const REDACTED_PREFIX = '[REDACTED:';

const marker = (kind: string): string => `${REDACTED_PREFIX}${kind}]`;

interface TokenRule {
  readonly kind: string;
  readonly pattern: RegExp;
  /** Number of leading capture groups to keep (for example a `Bearer ` prefix). */
  readonly keep?: number;
}

const TOKEN_RULES: readonly TokenRule[] = [
  {
    kind: 'private_key',
    pattern:
      /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'groq_key', pattern: /\bgsk_[A-Za-z0-9]{20,}/g },
  { kind: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  {
    kind: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'stripe_key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'huggingface_token', pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: 'npm_token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { kind: 'bearer_token', pattern: /(\b[Bb]earer\s+)[A-Za-z0-9._~+/=-]{16,}/g, keep: 1 },
  {
    kind: 'url_password',
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/g,
    keep: 1,
  },
];

/** Identifier names that hold secrets: SECRET_KEY, db_password, apiKey, GROQ_API_KEY... */
const KEY_NAME = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|client[_-]?secret|credentials?)s?(?:[_.-][A-Za-z0-9_.-]*)?`;

/** `key = "value"`, `"key": 'value'`, `config["KEY"] = 'value'`, `key => "value"`. */
const QUOTED_ASSIGNMENT = new RegExp(
  String.raw`((?<![A-Za-z0-9_])["']?${KEY_NAME}["']?\]?\s*(?:=>|:=|[:=])\s*)(["'\`])((?:(?!\2)[^\\\n]|\\.)*)\2`,
  'gi',
);

/** Env and YAML style: `API_TOKEN=abc123...` or `password: abc123...` at the start of a line. */
const UNQUOTED_ASSIGNMENT = new RegExp(
  String.raw`^(\s*(?:export\s+)?${KEY_NAME}(?:=|:[ \t]+))([^\s'"\`#()\[\]{},;]+)(?=[ \t]*(?:#|$))`,
  'gim',
);

const PLACEHOLDER =
  /^(?:\*+|x+|\.{3}|<[^>]*>|\$\{?[A-Za-z_]\w*\}?|%\([^)]*\)s|\{\{.*\}\}|changeme|change-me|example|placeholder|your[-_ ].*|none|null|true|false|test|dev|secret|password)$/i;

function isPlaceholder(value: string): boolean {
  return value.includes(REDACTED_PREFIX) || PLACEHOLDER.test(value);
}

export function redact(text: string): RedactionResult {
  let count = 0;
  const kinds = new Set<string>();
  const hit = (kind: string): string => {
    count++;
    kinds.add(kind);
    return marker(kind);
  };

  let out = text;
  for (const rule of TOKEN_RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      const kept = (args.slice(1, 1 + (rule.keep ?? 0)) as string[]).join('');
      return kept + hit(rule.kind);
    });
  }

  out = out.replace(QUOTED_ASSIGNMENT, (whole, prefix: string, quote: string, value: string) => {
    if (value.length < 4 || isPlaceholder(value)) return whole;
    return `${prefix}${quote}${hit('password_assignment')}${quote}`;
  });

  out = out.replace(UNQUOTED_ASSIGNMENT, (whole, prefix: string, value: string) => {
    // Unquoted values are only treated as secrets when they look like one.
    if (value.length < 8 || !/\d/.test(value) || isPlaceholder(value)) return whole;
    return `${prefix}${hit('password_assignment')}`;
  });

  return { text: out, count, kinds: [...kinds].sort() };
}

/** Convenience wrapper returning only the redacted text. */
export function redactText(text: string): string {
  return redact(text).text;
}
