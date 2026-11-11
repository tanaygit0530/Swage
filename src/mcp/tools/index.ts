import type { ToolRegistration } from '../server';
import { declareContext } from './declareContext';
import { findRelevantCode } from './findRelevantCode';
import { getSymbol } from './getSymbol';
import { readFiles } from './readFiles';
import { repoMap } from './repoMap';
import { runCommand } from './runCommand';
import { runTests } from './runTests';
import { stageEdit } from './stageEdit';
import { submitChangeSet } from './submitChangeSet';

/** All nine editor tools, in the order of blueprint section 6. */
export const EDITOR_TOOLS: readonly ToolRegistration[] = [
  findRelevantCode,
  repoMap,
  readFiles,
  getSymbol,
  declareContext,
  stageEdit,
  runTests,
  runCommand,
  submitChangeSet,
];

export const TOOL_NAMES = [
  'find_relevant_code',
  'repo_map',
  'read_files',
  'get_symbol',
  'declare_context',
  'stage_edit',
  'run_tests',
  'run_command',
  'submit_change_set',
] as const;

/** Preloaded into the agent's context (blueprint section 6, deferred loading). */
export const HOT_TOOLS = [
  'find_relevant_code',
  'read_files',
  'declare_context',
  'stage_edit',
  'submit_change_set',
] as const;

/** Discovered on demand, so deferred loading is visible in the TrueForge session. */
export const DEFERRED_TOOLS = TOOL_NAMES.filter(
  (t) => !(HOT_TOOLS as readonly string[]).includes(t),
);

/** TrueForge pauses these by name for the user's approval. */
export const APPROVAL_TOOLS = ['submit_change_set', 'run_command'] as const;
