import { parse, type ParseEntry } from 'shell-quote';

/**
 * Command policy for `run_tests` and `run_command` (blueprint section 6).
 *
 * - `run_test`: an allowlisted test command with safe arguments. It runs in the shadow
 *   copy, as an argv array with no shell, and needs no approval.
 * - `ask`: anything else that is not denied. TrueForge pauses and the user sees the
 *   exact command.
 * - `deny`: never run, even with approval.
 */

export type TestRunner = 'pytest' | 'npm' | 'vitest' | 'jest' | 'go' | 'cargo';

export type DenyCode =
  | 'empty_command'
  | 'destructive_delete'
  | 'privilege_escalation'
  | 'git_push'
  | 'pipe_to_shell'
  | 'system_path_write'
  | 'system_command'
  | 'shell_metacharacters'
  | 'dangerous_flag'
  | 'path_outside_workspace';

export type CommandDecision =
  | {
      readonly decision: 'run_test';
      readonly runner: TestRunner;
      /** Program and arguments, to be spawned without a shell. */
      readonly argv: readonly string[];
      readonly reason: string;
    }
  | { readonly decision: 'ask'; readonly reason: string }
  | { readonly decision: 'deny'; readonly code: DenyCode; readonly reason: string };

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
]);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'node', 'perl', 'ruby', 'php']);
const ESCALATION = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas', 'gsudo']);
const SYSTEM_COMMANDS = new Set([
  'mkfs',
  'fdisk',
  'parted',
  'diskutil',
  'format',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'launchctl',
  'systemctl',
  'crontab',
]);
const WRITE_COMMANDS = new Set([
  'tee',
  'cp',
  'mv',
  'install',
  'dd',
  'chmod',
  'chown',
  'chgrp',
  'ln',
  'rm',
  'rmdir',
  'truncate',
  'mkdir',
  'touch',
  'sed',
  'rsync',
]);

const SYSTEM_PATH =
  /^(?:\/(?:etc|usr|bin|sbin|lib|lib64|boot|dev(?!\/null$)|sys|proc|root|var|opt|System|Library|private\/etc)(?:\/|$)|\/$|~\/\.(?:ssh|bashrc|zshrc|profile|bash_profile|config)|[A-Za-z]:\\(?:Windows|Program Files)|\$HOME\/\.)/i;

/** Raw characters that mean shell evaluation, even inside double quotes. */
const RAW_METACHARACTERS = /[`$\n\r]/;

type Op = Extract<ParseEntry, { op: string }>;

function isOp(entry: ParseEntry): entry is Op {
  return typeof entry === 'object' && 'op' in entry;
}

/** Program name without directory, `.exe` or a version suffix such as `python3.13`. */
function programName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, '');
}

function isPython(name: string): boolean {
  return /^python(?:3(?:\.\d+)?)?$/.test(name);
}

function deny(code: DenyCode, reason: string): CommandDecision {
  return { decision: 'deny', code, reason };
}

const SEPARATORS = new Set<string>(['|', '||', '&&', ';', ';;', '&', '|&', '(', ')', '<(', '>(']);
const REDIRECTS = new Set<string>(['>', '>>', '>|', '&>', '>&']);

/** Splits parsed entries into simple commands at `;`, `&&`, `||`, `|` and `&`. */
function segments(entries: readonly ParseEntry[]): { words: string[]; pipedFrom: boolean }[] {
  const out: { words: string[]; pipedFrom: boolean }[] = [];
  let current: string[] = [];
  let pipedFrom = false;
  for (const e of entries) {
    if (isOp(e) && SEPARATORS.has(e.op)) {
      if (current.length > 0) out.push({ words: current, pipedFrom });
      current = [];
      pipedFrom = e.op === '|' || e.op === '|&';
      continue;
    }
    if (typeof e === 'string') current.push(e);
  }
  if (current.length > 0) out.push({ words: current, pipedFrom });
  return out;
}

/** Drops leading `VAR=value` assignments and returns the program and its arguments. */
function commandWords(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++;
  return words.slice(i);
}

function checkDenyRules(
  command: string,
  entries: readonly ParseEntry[],
): CommandDecision | undefined {
  // Redirections into system paths: `> /etc/hosts`, `>> ~/.bashrc`.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const next = entries[i + 1];
    if (e && isOp(e) && REDIRECTS.has(e.op) && typeof next === 'string') {
      if (SYSTEM_PATH.test(next)) {
        return deny('system_path_write', `Writing to ${next} is not allowed.`);
      }
    }
  }

  for (const seg of segments(entries)) {
    const words = commandWords(seg.words);
    const [first, ...args] = words;
    if (first === undefined) continue;
    const name = programName(first);

    if (ESCALATION.has(name)) {
      return deny(
        'privilege_escalation',
        `${name} is never allowed; Swage does not run privileged commands.`,
      );
    }
    if (SYSTEM_COMMANDS.has(name) || /^mkfs(?:\.|$)/.test(name)) {
      return deny('system_command', `${name} changes the system and is never allowed.`);
    }
    if (seg.pipedFrom && INTERPRETERS.has(name)) {
      return deny(
        'pipe_to_shell',
        `Piping output into ${name} runs unreviewed code and is never allowed.`,
      );
    }
    if (SHELLS.has(name) && /\b(?:curl|wget|iwr|invoke-webrequest)\b/i.test(command)) {
      return deny('pipe_to_shell', 'Running downloaded content through a shell is never allowed.');
    }
    if (name === 'git' && args.includes('push')) {
      return deny(
        'git_push',
        'git push publishes code and is never run by the agent; the user pushes.',
      );
    }
    if (name === 'rm') {
      const flags = args.filter((a) => a.startsWith('-'));
      const recursive = flags.some(
        (f) => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)),
      );
      const force = flags.some((f) => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')));
      if (recursive && force) {
        return deny(
          'destructive_delete',
          'rm -rf is never allowed. Ask the user to delete files themselves.',
        );
      }
    }
    if (WRITE_COMMANDS.has(name) || name === 'dd') {
      const target = args.find((a) => SYSTEM_PATH.test(a.replace(/^of=/, '')));
      if (target !== undefined) {
        return deny(
          'system_path_write',
          `${name} on ${target} touches a system path and is never allowed.`,
        );
      }
    }
  }
  return undefined;
}

interface TestMatch {
  readonly runner: TestRunner;
  /** Index in argv where runner arguments start. */
  readonly argsFrom: number;
}

function matchTestCommand(argv: readonly string[]): TestMatch | undefined {
  const [p0, p1, p2] = argv;
  if (p0 === undefined) return undefined;
  const name = programName(p0);
  if (name === 'pytest' || name === 'py.test') return { runner: 'pytest', argsFrom: 1 };
  if (isPython(name) && p1 === '-m' && p2 === 'pytest') return { runner: 'pytest', argsFrom: 3 };
  if (name === 'npm' && (p1 === 'test' || p1 === 't')) return { runner: 'npm', argsFrom: 2 };
  if (name === 'npm' && p1 === 'run' && p2 === 'test') return { runner: 'npm', argsFrom: 3 };
  if (name === 'npx' && p1 === 'vitest') return { runner: 'vitest', argsFrom: 2 };
  if (name === 'vitest') return { runner: 'vitest', argsFrom: 1 };
  if (name === 'npx' && p1 === 'jest') return { runner: 'jest', argsFrom: 2 };
  if (name === 'jest') return { runner: 'jest', argsFrom: 1 };
  if (name === 'go' && p1 === 'test') return { runner: 'go', argsFrom: 2 };
  if (name === 'cargo' && p1 === 'test') return { runner: 'cargo', argsFrom: 2 };
  return undefined;
}

/** Flags that load arbitrary code, open a debugger, or read or write outside the run. */
const DANGEROUS_FLAGS: Record<TestRunner, readonly string[]> = {
  pytest: [
    '-p',
    '-c',
    '-o',
    '--pdb',
    '--pdbcls',
    '--trace',
    '--config-file',
    '--rootdir',
    '--confcutdir',
    '--basetemp',
    '--override-ini',
    '--junitxml',
    '--junit-xml',
    '--debug',
    '--log-file',
    '--pastebin',
  ],
  npm: [
    '--prefix',
    '--script-shell',
    '--userconfig',
    '--globalconfig',
    '-g',
    '--global',
    '--registry',
  ],
  vitest: [
    '-c',
    '--config',
    '-r',
    '--root',
    '--dir',
    '--globalSetup',
    '--reporter',
    '--outputFile',
    '--api',
    '--ui',
    '--inspect',
    '--inspect-brk',
  ],
  jest: [
    '-c',
    '--config',
    '--rootDir',
    '--globalSetup',
    '--globalTeardown',
    '--reporters',
    '--testRunner',
    '--outputFile',
    '--watch',
    '--watchAll',
  ],
  go: ['-exec', '-toolexec', '-o', '-overlay', '-modfile', '-c'],
  cargo: ['--config', '-Z', '--manifest-path', '--target-dir'],
};

function findDangerousFlag(runner: TestRunner, args: readonly string[]): string | undefined {
  const list = DANGEROUS_FLAGS[runner];
  for (const arg of args) {
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0] ?? arg;
    if (list.includes(name)) return arg;
    // Short flags with an attached value, such as `-pno:cacheprovider` or `-cfoo.ini`.
    const short = list.filter((f) => /^-[A-Za-z]$/.test(f));
    if (/^-[A-Za-z]/.test(arg) && !arg.startsWith('--') && short.some((f) => arg.startsWith(f))) {
      return arg;
    }
  }
  return undefined;
}

function findOutsidePath(args: readonly string[]): string | undefined {
  return args.find((a) => {
    const value = a.includes('=') && a.startsWith('-') ? (a.split('=')[1] ?? '') : a;
    if (value.startsWith('-')) return false;
    return /^(?:\/|~|[A-Za-z]:[\\/]|\\\\)/.test(value) || value.split(/[\\/]/).includes('..');
  });
}

/** Classifies a command string from the agent. */
export function classifyCommand(command: string): CommandDecision {
  const trimmed = command.trim();
  if (trimmed === '') return deny('empty_command', 'The command is empty.');

  const entries = parse(trimmed);
  const denied = checkDenyRules(trimmed, entries);
  if (denied) return denied;

  const words = entries.filter((e): e is string => typeof e === 'string');
  const hasStructure = entries.some((e) => typeof e !== 'string');
  const test = matchTestCommand(words);

  if (!test) {
    return {
      decision: 'ask',
      reason: 'This is not an allowlisted test command, so the user must approve it.',
    };
  }

  if (hasStructure || RAW_METACHARACTERS.test(trimmed)) {
    return deny(
      'shell_metacharacters',
      'Test commands run without a shell, so pipes, redirects, globs, variables and command chains are rejected. Pass plain arguments only.',
    );
  }

  const args = words.slice(test.argsFrom);
  const flag = findDangerousFlag(test.runner, args);
  if (flag !== undefined) {
    return deny('dangerous_flag', `The flag ${flag} is not allowed in test commands.`);
  }
  const outside = findOutsidePath(args);
  if (outside !== undefined) {
    return deny(
      'path_outside_workspace',
      `${outside} points outside the workspace. Use paths relative to the workspace root.`,
    );
  }

  return {
    decision: 'run_test',
    runner: test.runner,
    argv: words,
    reason: `Allowlisted ${test.runner} command; runs in the shadow copy without a shell.`,
  };
}
