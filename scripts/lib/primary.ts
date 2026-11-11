import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { isSeq, parseDocument } from 'yaml';
import { providerName } from '../../src/resilience/profiles';

/**
 * Pure edits for scripts/break-primary and scripts/restore-primary (blueprint section 10, Task C):
 * point the primary profile at a model that cannot answer, and put it back. Formatting and
 * comments survive: settings.json is edited as JSONC, YAML profiles through the YAML document.
 * Only the primary's trueforgeModel, label and timeouts change.
 */

export type ProfilesFormat = 'settings' | 'json' | 'yaml';

export interface PrimarySnapshot {
  readonly trueforgeModel: string;
  readonly label?: string;
  readonly timeouts?: Readonly<Record<string, number>>;
}

/** Short timers for the demo, in case an unreachable endpoint hangs instead of refusing. */
export const DEMO_TIMEOUTS = { connectMs: 5000, firstTokenMs: 15_000 } as const;

export function formatOf(file: string): ProfilesFormat {
  if (/settings\.json$/i.test(file)) return 'settings';
  return /\.ya?ml$/i.test(file) ? 'yaml' : 'json';
}

function jsonPath(format: ProfilesFormat): (string | number)[] {
  return format === 'settings' ? ['swage.models'] : ['profiles'];
}

function readList(text: string, format: ProfilesFormat): unknown[] | undefined {
  if (format === 'yaml') {
    const data = parseDocument(text).toJS() as { profiles?: unknown } | unknown[] | null;
    const list = Array.isArray(data) ? data : data?.profiles;
    return Array.isArray(list) ? list : undefined;
  }
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
  if (errors.length > 0 || !data || typeof data !== 'object') return undefined;
  const list = data[jsonPath(format)[0] as string];
  return Array.isArray(list) ? list : undefined;
}

/** The primary profile in a file, or undefined if the file has no profiles. */
export function readPrimary(
  text: string,
  format: ProfilesFormat,
): { primary: PrimarySnapshot; count: number } | undefined {
  const list = readList(text, format);
  const first = list?.[0] as Partial<PrimarySnapshot> | undefined;
  if (!list || !first || typeof first.trueforgeModel !== 'string') return undefined;
  return {
    primary: {
      trueforgeModel: first.trueforgeModel,
      ...(typeof first.label === 'string' ? { label: first.label } : {}),
      ...(first.timeouts && typeof first.timeouts === 'object'
        ? { timeouts: { ...first.timeouts } }
        : {}),
    },
    count: list.length,
  };
}

/** Sets (or removes, with undefined) one field of the primary profile. */
function setField(text: string, format: ProfilesFormat, key: string, value: unknown): string {
  if (format === 'yaml') {
    const doc = parseDocument(text);
    const list = isSeq(doc.contents) ? [0] : ['profiles', 0];
    const path = [...list, key];
    if (value === undefined) doc.deleteIn(path);
    else doc.setIn(path, value);
    return doc.toString();
  }
  const edits = modify(text, [...jsonPath(format), 0, key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(text, edits);
}

export interface BreakResult {
  readonly text: string;
  readonly original: PrimarySnapshot;
  readonly profiles: number;
}

/**
 * Points the primary at `brokenModel`, keeps its display name (so the banner still says
 * "because Gemini ..."), and caps its connect and first-token timers for the demo.
 */
export function breakPrimaryText(
  text: string,
  format: ProfilesFormat,
  brokenModel: string,
): BreakResult {
  const found = readPrimary(text, format);
  if (!found) throw new Error('no model profiles in this file');
  const { primary } = found;
  if (primary.trueforgeModel === brokenModel) throw new Error('the primary is already broken');
  let out = setField(text, format, 'trueforgeModel', brokenModel);
  out = setField(out, format, 'label', primary.label ?? providerName(primary.trueforgeModel));
  out = setField(out, format, 'timeouts', {
    ...(primary.timeouts ?? {}),
    connectMs: Math.min(
      primary.timeouts?.['connectMs'] ?? DEMO_TIMEOUTS.connectMs,
      DEMO_TIMEOUTS.connectMs,
    ),
    firstTokenMs: Math.min(
      primary.timeouts?.['firstTokenMs'] ?? DEMO_TIMEOUTS.firstTokenMs,
      DEMO_TIMEOUTS.firstTokenMs,
    ),
  });
  return { text: out, original: primary, profiles: found.count };
}

/**
 * Puts the saved primary back, but only while the file still has the broken model: a primary
 * someone changed since is left alone.
 */
export function restorePrimaryText(
  text: string,
  format: ProfilesFormat,
  original: PrimarySnapshot,
  brokenModel: string,
): { text: string; restored: boolean } {
  const found = readPrimary(text, format);
  if (found?.primary.trueforgeModel !== brokenModel) return { text, restored: false };
  let out = setField(text, format, 'trueforgeModel', original.trueforgeModel);
  out = setField(out, format, 'label', original.label);
  out = setField(out, format, 'timeouts', original.timeouts);
  return { text: out, restored: true };
}
