/**
 * Pinned TrueForge versions (blueprint sections 9 and 15). Verified on 11 November 2026:
 * `@truefoundry/trueforge@0.184.2` is npm `latest` (tag `@truefoundry/trueforge@0.184.2`,
 * commit 235518c), and `@truefoundry/trueforge-sdk@0.184.1` is the newest SDK. See docs/SPIKES.md.
 */
export const TRUEFORGE_VERSION = '0.184.2';
export const TRUEFORGE_SDK_VERSION = '0.184.1';

/** Hosts TrueForge may call on loopback: local models and Swage's MCP server. */
export const OUTBOUND_ALLOWED_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

/** Agent names TrueForge reserves (blueprint section 15). */
export const RESERVED_AGENT_NAMES: readonly string[] = ['tfg', 'trueforge'];
