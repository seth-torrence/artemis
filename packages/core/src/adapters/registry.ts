/**
 * The provider registry.
 *
 * A map from {@link ProviderId} to a live {@link ProviderAdapter}, plus the one
 * place that turns adapters into the {@link ProviderDescriptor} list the
 * renderer sees.
 *
 * Adding a provider is a single line — see
 * {@link createDefaultProviderRegistry}. Everything else that a new provider
 * needs (capability-driven UI degradation, permission plumbing, session
 * listing, and the credential→environment mapping) is keyed off the seam, so
 * the registry has nothing provider-specific in it beyond a display label.
 *
 * That last item was for a long time the exception that made the claim untrue:
 * credential resolution wrote Anthropic's variable names for every provider.
 * It now comes from `ProviderAdapter.credentials`, which is also where this
 * file reads `signInHowTo` from, so the profile screen explains a sign-in in
 * the words of the adapter whose command it is about to generate.
 *
 * ## Why unregistered providers still appear
 *
 * `describe()` returns a descriptor for *every* known {@link ProviderId}, not
 * just the registered ones, marking the rest unavailable with a reason. Hiding
 * a provider entirely tells the user nothing; showing "Codex — not yet
 * supported in this build" tells them where the product is going and stops them
 * hunting for a setting that does not exist. Protocol's `ProviderDescriptor`
 * carries `available` + `unavailableReason` precisely so the UI can grey a row
 * out rather than drop it.
 */

import type { ProviderDescriptor, ProviderId, ProviderKind } from '@rx-artemis/protocol';
import { NO_CAPABILITIES, PROVIDER_IDS } from '@rx-artemis/protocol';

import { createArtemisAdapter } from './artemis/adapter.js';
import { createClaudeAdapter } from './claude.js';
import type { ClaudeAdapterOptions } from './claude.js';
import { createCodexAdapter } from './codex.js';
import type { CodexAdapterOptions } from './codex.js';
import { createOpencodeAdapter } from './opencode.js';
import { createLocalAdapter, LLAMA_CPP, LM_STUDIO, OLLAMA } from './local/adapter.js';
import type { LocalAdapterOptions } from './local/adapter.js';
import type { OpencodeAdapterOptions } from './opencode.js';
import { adapterError } from './types.js';
import type {
  AdapterAvailability,
  EnvBundle,
  ProviderAdapter,
  ProviderRegistry,
} from './types.js';

/** Display names for every known provider, including ones not yet implemented. */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  llamacpp: 'llama.cpp',
  artemis: 'Artemis Server',
};

/**
 * Which half of the profile screen's picker each provider belongs to — see
 * {@link ProviderKind}. Kept here beside {@link PROVIDER_LABELS} and for the
 * same reason: the split is a fact about the provider, not about the UI, and
 * it has to cover providers this build has no adapter for.
 *
 * OpenCode is `hosted` despite running on this machine: its profile is a
 * config directory entered through the provider's own sign-in, which is the
 * hosted entry model. The `local` half is for the raw endpoints — no account,
 * just an address.
 */
const PROVIDER_KINDS: Readonly<Record<ProviderId, ProviderKind>> = {
  claude: 'hosted',
  codex: 'hosted',
  opencode: 'hosted',
  lmstudio: 'local',
  ollama: 'local',
  llamacpp: 'local',
  // Another Artemis's server: no account, just an address and a connection
  // token — the `local` entry model, even when the machine is elsewhere.
  artemis: 'local',
};

/** Why a known provider is missing from this build. */
const NOT_IMPLEMENTED_REASON = 'Not supported in this version of Artemis yet.';

/** Create an empty registry, optionally seeded with adapters. */
export function createProviderRegistry(
  adapters: readonly ProviderAdapter[] = [],
): ProviderRegistry {
  const byId = new Map<ProviderId, ProviderAdapter>();
  const availabilityCache = new Map<ProviderId, AdapterAvailability>();

  const registry: ProviderRegistry = {
    register(adapter, options) {
      if (byId.has(adapter.id) && options?.replace !== true) {
        throw adapterError(
          'invalid_request',
          `A "${adapter.id}" adapter is already registered. Pass { replace: true } to override it.`,
        );
      }
      byId.set(adapter.id, adapter);
      availabilityCache.delete(adapter.id);
    },

    unregister(id) {
      availabilityCache.delete(id);
      return byId.delete(id);
    },

    has(id) {
      return byId.has(id);
    },

    get(id) {
      return byId.get(id);
    },

    require(id) {
      const adapter = byId.get(id);
      if (adapter === undefined) {
        throw adapterError('provider_not_found', `No adapter is registered for provider "${id}".`);
      }
      return adapter;
    },

    list() {
      // `PROVIDER_IDS` is the display order, so the UI never has to sort.
      return PROVIDER_IDS.map((id) => byId.get(id)).filter(
        (adapter): adapter is ProviderAdapter => adapter !== undefined,
      );
    },

    async describe(options) {
      if (options?.refresh === true) availabilityCache.clear();
      const includeUnregistered = options?.includeUnregistered !== false;

      const descriptors: ProviderDescriptor[] = [];
      for (const id of PROVIDER_IDS) {
        const adapter = byId.get(id);

        if (adapter === undefined) {
          if (!includeUnregistered) continue;
          descriptors.push({
            id,
            kind: PROVIDER_KINDS[id],
            label: PROVIDER_LABELS[id],
            capabilities: NO_CAPABILITIES,
            // No adapter, so no sign-in instructions to give. The profile
            // editor says the provider is unavailable rather than handing out
            // someone else's command.
            models: [],
            effortLevels: [],
            available: false,
            unavailableReason: NOT_IMPLEMENTED_REASON,
          });
          continue;
        }

        const availability = await resolveAvailability(
          adapter,
          availabilityCache,
          await options?.envFor?.(id),
        );
        descriptors.push({
          id,
          kind: PROVIDER_KINDS[id],
          label: adapter.label,
          capabilities: adapter.capabilities,
          // Published so the profile screen can explain the sign-in it is about
          // to generate a command for, in the words of the adapter that owns
          // that command — the same pattern as the permission-mode picker
          // reading `capabilities.permissionModes`.
          signInHowTo: adapter.credentials.signIn.howTo,
          // And the same again for the model and effort pickers. An adapter
          // that declares neither publishes empty lists rather than absent
          // ones, so the renderer can tell "no choice offered" from "this
          // descriptor predates the field" without a second code path.
          models: adapter.models ?? [],
          effortLevels: adapter.effortLevels ?? [],
          // Absent unless the adapter runs commands itself — see
          // `describeSandbox`. A `?? undefined` rather than a branch, so an
          // adapter that gains the method later needs no change here.
          ...(adapter.describeSandbox === undefined
            ? {}
            : { sandbox: await adapter.describeSandbox() }),
          available: availability.available,
          unavailableReason: availability.available
            ? undefined
            : (availability.unavailableReason ?? 'Unavailable.'),
        });
      }

      return descriptors;
    },
  };

  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

async function resolveAvailability(
  adapter: ProviderAdapter,
  cache: Map<ProviderId, AdapterAvailability>,
  env: EnvBundle | undefined,
): Promise<AdapterAvailability> {
  const cached = cache.get(adapter.id);
  if (cached !== undefined) return cached;

  let availability: AdapterAvailability;
  if (adapter.checkAvailability === undefined) {
    // No probe means "always usable once registered".
    availability = { available: true };
  } else {
    try {
      availability = await adapter.checkAvailability(env === undefined ? undefined : { env });
    } catch (error) {
      // A probe that throws is itself evidence the provider is not usable, and
      // it must never take down the whole `providers:list` call.
      availability = {
        available: false,
        unavailableReason: `Could not check availability: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
  }

  cache.set(adapter.id, availability);
  return availability;
}

/** Options for {@link createDefaultProviderRegistry}. */
export interface DefaultProviderRegistryOptions {
  /** Forwarded to the Claude adapter. */
  readonly claude?: ClaudeAdapterOptions;
  /** Forwarded to the Codex adapter. */
  readonly codex?: CodexAdapterOptions;
  /** Forwarded to the OpenCode adapter. */
  readonly opencode?: OpencodeAdapterOptions;
  /**
   * Forwarded to all three local adapters.
   *
   * One field for three rows, because the three differ only in how you ask a
   * server what models it has — the loop, the tools and therefore the tool
   * servers are the same file. See `local/adapter.ts`.
   */
  readonly local?: LocalAdapterOptions;
}

/**
 * The registry Artemis ships with.
 *
 * **This is the one-line registration point**, and it held: adding Codex was
 * this array plus an options field. Nothing else in the app changed, because
 * everything downstream reads capabilities rather than provider identity — the
 * permission-mode picker, the model picker and the history pane all rebuild
 * themselves from the descriptor.
 */
export function createDefaultProviderRegistry(
  options?: DefaultProviderRegistryOptions,
): ProviderRegistry {
  return createProviderRegistry([
    createClaudeAdapter(options?.claude),
    createCodexAdapter(options?.codex),
    createOpencodeAdapter(options?.opencode),
    // Three rows, one adapter. They differ in how you ask what models exist,
    // not in how a turn runs — see `local/adapter.ts`.
    createLocalAdapter(LM_STUDIO, options?.local),
    createLocalAdapter(OLLAMA, options?.local),
    createLocalAdapter(LLAMA_CPP, options?.local),
    // And the endpoint that is another Artemis — its own adapter, because the
    // remote end runs the whole agent turn. See `artemis/adapter.ts`.
    createArtemisAdapter(),
  ]);
}
