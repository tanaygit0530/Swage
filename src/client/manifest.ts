import { serialization, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { RESERVED_AGENT_NAMES } from '../supervisor/pin';

/**
 * Agent manifests (blueprint section 6). The files in trueforge/agents hold everything
 * except the model: the model name comes from the active profile at runtime.
 */

export type AgentSpec = TrueForgeApi.AgentSpec;

/** Placeholder in the committed files; never sent to TrueForge. */
export const MODEL_PLACEHOLDER = '<provider>/<model>';

/** TrueForge resource names: lowercase letters, digits and hyphens (verified in the OpenAPI spec). */
export const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export interface ModelProfile {
  /** Profile name, for example `primary` or `fallback-1`. */
  readonly name: string;
  /** TrueForge model FQN, for example `google-gemini/gemini-3-5-flash`. */
  readonly trueforgeModel: string;
  /** Where the model runs; local models get longer timeouts (blueprint section 8). */
  readonly kind?: 'hosted' | 'local';
  readonly params?: { readonly temperature?: number; readonly max_tokens?: number };
  /** Layered timers for one attempt; missing values come from the kind's defaults. */
  readonly timeouts?: Partial<ProfileTimeouts>;
  /**
   * Inline edits only: agent mode never starts on or falls back to this profile (a small local
   * model that handles one selection well but not a multi-file task).
   */
  readonly inlineOnly?: boolean;
  /** Name shown in banners and the status bar; defaults to the provider, for example "Gemini". */
  readonly label?: string;
}

/** Per-attempt timers (blueprint section 8, resilience). */
export interface ProfileTimeouts {
  /** Until TrueForge accepts the turn (session created, turn started). */
  readonly connectMs: number;
  /** From the turn start until the model's first event. */
  readonly firstTokenMs: number;
  /** Silence after output began (tool executions excluded). */
  readonly stallMs: number;
  /** Hard ceiling for one attempt. */
  readonly totalMs: number;
}

export function assertAgentName(name: string): void {
  if (RESERVED_AGENT_NAMES.includes(name)) throw new Error(`"${name}" is reserved by TrueForge`);
  if (!RESOURCE_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a valid TrueForge name (lowercase letters, digits and hyphens)`,
    );
  }
}

/** Lowercase, hyphenated version of a profile name, safe inside a resource name. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Agent name for a base agent and a profile: `swage-main` + `fallback-1` -> `swage-main-fallback-1`. */
export function agentNameFor(base: string, profile: ModelProfile): string {
  const name = `${base}-${slug(profile.name)}`.slice(0, 64).replace(/-+$/, '');
  assertAgentName(name);
  return name;
}

/**
 * Parses a manifest file in TrueForge's wire format (snake_case, as in the create-agent docs)
 * into the SDK's camelCase AgentSpec. The SDK schema validates it and rejects unknown keys,
 * so a typo such as `mcp_server` fails here instead of being ignored by the server.
 */
export function parseManifest(json: string, source = 'manifest'): AgentSpec {
  let spec: AgentSpec;
  try {
    spec = serialization.AgentSpec.parseOrThrow(JSON.parse(json), {
      unrecognizedObjectKeys: 'fail',
    });
  } catch (err) {
    throw new Error(`${source}: ${(err as Error).message}`, { cause: err });
  }
  if (!spec.mcpServers?.some((s) => s.name === 'editor-tools')) {
    throw new Error(`${source}: mcp_servers must include editor-tools`);
  }
  return spec;
}

/** Serializes an AgentSpec back to the wire format, for files and logs. */
export function toWireManifest(spec: AgentSpec): unknown {
  return serialization.AgentSpec.jsonOrThrow(spec);
}

/** The manifest with the profile's model and parameters filled in. */
export function withProfile(spec: AgentSpec, profile: ModelProfile): AgentSpec {
  if (!profile.trueforgeModel.includes('/')) {
    throw new Error(
      `Model "${profile.trueforgeModel}" must be a TrueForge FQN like provider/model`,
    );
  }
  return {
    ...spec,
    model: {
      name: profile.trueforgeModel,
      // Profiles use the wire names (max_tokens); the SDK spec uses camelCase (maxTokens).
      params: {
        ...(spec.model.params ?? {}),
        ...(profile.params?.temperature === undefined
          ? {}
          : { temperature: profile.params.temperature }),
        ...(profile.params?.max_tokens === undefined
          ? {}
          : { maxTokens: profile.params.max_tokens }),
      },
    },
  };
}
