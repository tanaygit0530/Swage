/**
 * Command identifiers and titles contributed by the extension (blueprint section 3).
 * Kept free of any `vscode` import so it can be unit tested without VS Code.
 */
export interface CommandSpec {
  readonly id: string;
  readonly title: string;
}

export const COMMAND_PREFIX = 'swage.';

export const COMMANDS = [
  { id: 'swage.inlineEdit', title: 'Inline Edit' },
  { id: 'swage.openAgent', title: 'Open Agent' },
  { id: 'swage.stop', title: 'Stop' },
  { id: 'swage.reviewChanges', title: 'Review Changes' },
  { id: 'swage.undoLastChangeSet', title: 'Undo Last Change Set' },
  { id: 'swage.switchModel', title: 'Switch Model' },
  { id: 'swage.doctor', title: 'Doctor' },
] as const satisfies readonly CommandSpec[];

export type CommandId = (typeof COMMANDS)[number]['id'];

/** Context key that is true while an agent or inline-edit run is active. */
export const RUNNING_CONTEXT_KEY = 'swage.running';

export function stubMessage(spec: CommandSpec): string {
  return `Swage: ${spec.title} is not implemented yet.`;
}
