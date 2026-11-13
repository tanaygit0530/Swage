import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ModelProfile, ProfileTimeouts } from '../client/manifest';

/**
 * Model profiles (blueprint sections 8 and 9): an ordered list, primary first, each naming a
 * TrueForge model and its layered timeouts. Nothing here knows a model or provider name: the
 * organisers can swap the primary and every banner, agent name and status follows the config.
 */

export type { ProfileTimeouts };

/** Starting values from blueprint section 8. A slow local model must not look like a dead one. */
export const HOSTED_TIMEOUTS: ProfileTimeouts = Object.freeze({
  connectMs: 10_000,
  firstTokenMs: 45_000,
  stallMs: 30_000,
  totalMs: 600_000,
});
export const LOCAL_TIMEOUTS: ProfileTimeouts = Object.freeze({
  connectMs: 10_000,
  firstTokenMs: 120_000,
  stallMs: 60_000,
  totalMs: 900_000,
});

export interface ResolvedProfile extends ModelProfile {
  readonly kind: 'hosted' | 'local';
  readonly timeouts: ProfileTimeouts;
  /** Display name for banners and the status bar. */
  readonly label: string;
}

const Ms = z.number().int().min(100).max(3_600_000);

const ProfileSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/, 'letters, digits, dot, dash or underscore'),
    kind: z.enum(['hosted', 'local']).optional(),
    trueforgeModel: z
      .string()
      .regex(/^[^/\s]+\/\S+$/, 'must be a TrueForge model FQN like provider/model'),
    label: z.string().min(1).max(40).optional(),
    params: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    timeouts: z
      .object({
        connectMs: Ms.optional(),
        firstTokenMs: Ms.optional(),
        stallMs: Ms.optional(),
        totalMs: Ms.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** "google-gemini/gemini-x" -> "Gemini", "groq/..." -> "Groq": the provider's last word. */
export function providerName(fqn: string): string {
  const provider = fqn.split('/')[0] ?? fqn;
  const word = provider.split(/[-_.]/).filter(Boolean).at(-1) ?? provider;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function displayName(profile: Pick<ModelProfile, 'label' | 'trueforgeModel'>): string {
  return profile.label ?? providerName(profile.trueforgeModel);
}

/** Validates profiles and fills timeouts from the kind's defaults. Names must be unique. */
export function resolveProfiles(raw: unknown, source = 'profiles'): ResolvedProfile[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && 'profiles' in raw
      ? (raw as { profiles: unknown }).profiles
      : undefined;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`${source}: profiles must be a non-empty list`);
  const seen = new Set<string>();
  return list.map((item: unknown, i) => {
    const parsed = ProfileSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${source}: profile ${i}${issue?.path.length ? ` ${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid'}`,
      );
    }
    const p = parsed.data;
    if (seen.has(p.name)) throw new Error(`${source}: duplicate profile name "${p.name}"`);
    seen.add(p.name);
    const kind = p.kind ?? 'hosted';
    const defaults = kind === 'local' ? LOCAL_TIMEOUTS : HOSTED_TIMEOUTS;
    const t = p.timeouts ?? {};
    return {
      name: p.name,
      kind,
      trueforgeModel: p.trueforgeModel,
      label: p.label ?? providerName(p.trueforgeModel),
      ...(p.params
        ? {
            params: {
              ...(p.params.temperature === undefined ? {} : { temperature: p.params.temperature }),
              ...(p.params.max_tokens === undefined ? {} : { max_tokens: p.params.max_tokens }),
            },
          }
        : {}),
      timeouts: {
        connectMs: t.connectMs ?? defaults.connectMs,
        firstTokenMs: t.firstTokenMs ?? defaults.firstTokenMs,
        stallMs: t.stallMs ?? defaults.stallMs,
        totalMs: t.totalMs ?? defaults.totalMs,
      },
    };
  });
}

/** Parses a YAML (or JSON, a subset of YAML) profiles file. */
export function parseProfilesText(text: string, source = 'profiles'): ResolvedProfile[] {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new Error(`${source}: ${(err as Error).message.split('\n')[0] ?? 'not valid YAML'}`, {
      cause: err,
    });
  }
  return resolveProfiles(data, source);
}

/** Local file first (git-ignored), then the committed example. */
export const PROFILE_FILES = [
  'config/models.yaml',
  'config/models.yml',
  'config/models.json',
  'config/models.example.yaml',
] as const;

/** The first profiles file that exists under `dir`, parsed. */
export function loadProfilesFile(dir: string): { file: string; profiles: ResolvedProfile[] } {
  for (const rel of PROFILE_FILES) {
    const file = path.join(dir, rel);
    if (existsSync(file))
      return { file: rel, profiles: parseProfilesText(readFileSync(file, 'utf8'), rel) };
  }
  throw new Error(`No profiles file: create ${PROFILE_FILES[0]} from config/models.example.yaml`);
}

/**
 * The extension's profiles: the `swage.models` setting when it has entries, otherwise the
 * profiles file next to the extension (a development checkout).
 */
export function profilesFrom(setting: unknown, extensionDir?: string): ResolvedProfile[] {
  if (Array.isArray(setting) && setting.length > 0) return resolveProfiles(setting, 'swage.models');
  if (extensionDir) return loadProfilesFile(extensionDir).profiles;
  throw new Error(
    'No model profile: add one to the swage.models setting (see config/models.example.yaml).',
  );
}

/** Providers that usually run on the user's machine, so a new profile for them is `local`. */
const LOCAL_PROVIDER = /ollama|llama|lmstudio|vllm|local/i;

/**
 * A profile for a TrueForge model added from the model picker: a unique name (`added-1`, ...),
 * `local` timeouts for local providers, and no label (it comes from the provider).
 */
export function profileForModel(
  trueforgeModel: string,
  existingNames: readonly string[],
): { name: string; kind: 'hosted' | 'local'; trueforgeModel: string } {
  let n = 1;
  while (existingNames.includes(`added-${n}`)) n++;
  const provider = trueforgeModel.split('/')[0] ?? '';
  return {
    name: `added-${n}`,
    kind: LOCAL_PROVIDER.test(provider) ? 'local' : 'hosted',
    trueforgeModel,
  };
}
