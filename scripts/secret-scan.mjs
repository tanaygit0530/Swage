#!/usr/bin/env node
// Secret scan of the whole git history (blueprint section 13: "no API keys or secrets anywhere in
// history"). Reads every blob reachable from any ref, plus the working tree, and looks for real
// key formats. Matches are printed redacted (first 4 characters only). Exit code 1 on a finding.
//
//   node scripts/secret-scan.mjs            history + working tree
//   node scripts/secret-scan.mjs --worktree working tree only (fast, used in CI)
import { execFileSync, spawnSync } from 'node:child_process';

const RULES = [
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35,}/g],
  ['OpenAI key', /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}\b/g],
  ['Groq key', /\bgsk_[A-Za-z0-9]{40,}\b/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{30,}\b/g],
  [
    'GitHub token',
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  ],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}\b/g],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ['Bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/g],
  [
    'Assigned secret',
    /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\b["']?\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/gi,
  ],
];

// Test fixtures that exist to exercise the redactor and the scanner itself, with fake values.
const ALLOW_PATHS = [
  /^test\/unit\/safety\/redact\.test\.ts$/,
  /^test\/unit\/resilience\/classify\.test\.ts$/,
];
// dev-secret-value: the sample app in test/rehearse that proves `flask config` masks secrets.
const ALLOW_VALUES = [
  /EXAMPLE|example|placeholder|fake|dummy|xxxx|test-?token|\*\*\*|dev-secret-value/,
];

function scan(path, text, where, findings) {
  if (ALLOW_PATHS.some((r) => r.test(path))) return;
  for (const [name, re] of RULES) {
    for (const m of text.matchAll(re)) {
      if (ALLOW_VALUES.some((r) => r.test(m[0]))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push(`${name}: ${path}:${line} (${where}) ${m[0].slice(0, 4)}…`);
    }
  }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
const findings = [];
let blobs = 0;

if (!process.argv.includes('--worktree')) {
  // Every blob in history, with one path it was committed under.
  const objects = git('rev-list', '--all', '--objects')
    .split('\n')
    .map((l) => l.split(' '))
    .filter(([sha, path]) => sha && path);
  const seen = new Set();
  for (const [sha, path] of objects) {
    if (seen.has(sha) || /\.(png|jpe?g|gif|webp|ico|pdf|wasm|vsix|woff2?)$/i.test(path)) continue;
    seen.add(sha);
    const r = spawnSync('git', ['cat-file', '-p', sha], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.status !== 0 || r.stdout.includes('\u0000')) continue;
    blobs++;
    scan(path, r.stdout, `blob ${sha.slice(0, 8)}`, findings);
  }
}
for (const path of git('ls-files', '--cached', '--others', '--exclude-standard')
  .split('\n')
  .filter(Boolean)) {
  if (/\.(png|jpe?g|gif|webp|ico|pdf|wasm|vsix|woff2?)$/i.test(path)) continue;
  const r = spawnSync('cat', [path], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status === 0 && !r.stdout.includes('\u0000'))
    scan(path, r.stdout, 'working tree', findings);
}

const commits = git('rev-list', '--all', '--count').trim();
console.log(
  `Secret scan: ${commits} commits, ${blobs} unique blobs in history, plus the working tree.`,
);
if (findings.length) {
  for (const f of [...new Set(findings)]) console.log(`  FOUND ${f}`);
  process.exit(1);
}
console.log('No secrets found.');
