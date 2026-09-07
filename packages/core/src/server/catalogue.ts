/**
 * What the server has to offer, assembled once and kept warm.
 * ============================================================================
 *
 * The server answers "which accounts, and which models on each" — and neither
 * half is free to compute. Profiles come out of a store, provider descriptors
 * out of the registry, but the *models* come from asking each provider's CLI
 * what the account actually has, which spawns a subprocess and takes seconds.
 * With four profiles configured, an uncached `GET /v1/models` would spawn four
 * of them, and a client that polls — which is what editor extensions do — would
 * keep doing it forever.
 *
 * So this module exists to put exactly one cache in exactly one place.
 *
 * ## What is cached, and for how long
 *
 * The assembled catalogue, whole, for {@link DEFAULT_CATALOGUE_TTL_MS}. Not the
 * individual model lists: the slug assignment is a property of the *set* of
 * profiles (see `assignProfileSlugs`), so caching per profile and reassembling
 * would let two halves of one answer disagree about who owns the bare slug.
 *
 * Five minutes because of what actually changes underneath. A model catalogue
 * moves when a provider ships a model or a plan changes — a scale of days —
 * while the cost of being stale is that a brand-new model is missing from one
 * poll. `?refresh=1` is there for the caller who knows better, and the settings
 * tab passes it when the user asks.
 *
 * ## Concurrent callers share one build
 *
 * A cold cache met by three simultaneous requests must not start three builds.
 * The in-flight promise is stored and handed to everyone who arrives while it
 * is running, so the subprocesses are spawned once no matter how many clients
 * showed up at once. This is the single most important line in the file: the
 * failure without it is not a slow response, it is a fork bomb of CLI processes
 * proportional to client count.
 */

import type {
  AuthStatusInfo,
  Capabilities,
  ProfileMetadata,
  ProviderDescriptor,
  ProviderId,
  ProviderModelOption,
  ServerModel,
  ServerProfile,
  ServerThinkingLevel,
} from '@rx-artemis/protocol';
import { assignProfileSlugs, modelRoute } from '@rx-artemis/protocol';

import type { ProfileId } from '@rx-artemis/protocol';

/** Five minutes. See the file comment for why. */
export const DEFAULT_CATALOGUE_TTL_MS = 5 * 60_000;

/**
 * What the catalogue needs from the engine.
 *
 * An interface rather than the engine itself, and the reason is the rule this
 * package is built on: `@rx-artemis/core` must never import Electron, and the
 * engine that can answer these lives in the main process. Three methods is also
 * a small enough seam to fake in a test without standing up an app.
 */
export interface CatalogueSource {
  /** Every profile, in the store's own order. That order decides slug ties. */
  listProfiles(): Promise<readonly ProfileMetadata[]>;
  /** Every provider descriptor, registered or not. Instant by contract. */
  listProviders(): Promise<readonly ProviderDescriptor[]>;
  /**
   * One account's model catalogue. Slow — it spawns the provider's CLI — and
   * contractually never throws: a provider that cannot enumerate answers with
   * its built-in list and `live: false`.
   */
  listModels(query: {
    readonly providerId: ProviderId;
    readonly profileId: ProfileId;
  }): Promise<{ readonly models: readonly ProviderModelOption[]; readonly live: boolean }>;
  /**
   * Does one account's directory hold a credential?
   *
   * Slow in the same way {@link listModels} is — it spawns the provider's CLI
   * to ask — which is why it is answered on the same cached build rather than
   * per request. Optional: a source that cannot probe leaves it off, and every
   * consumer treats an absent answer as "not checked" rather than as healthy.
   *
   * Contractually never throws, for the same reason the sign-in probe does not:
   * every caller is a surface that has to render something either way.
   */
  checkAuth?(query: {
    readonly providerId: ProviderId;
    readonly profileId: ProfileId;
  }): Promise<AuthStatusInfo>;
}

export interface CatalogueOptions {
  readonly source: CatalogueSource;
  /** How long an assembled catalogue stays good. Defaults to {@link DEFAULT_CATALOGUE_TTL_MS}. */
  readonly ttlMs?: number;
  /** Injected so a test can move time without waiting for it. */
  readonly now?: () => number;
}

export interface Catalogue {
  /**
   * The catalogue, from cache when it is warm.
   *
   * `refresh` skips the cache and replaces it. It does *not* skip the in-flight
   * dedupe: two forced refreshes that overlap still share one build, because
   * the second would otherwise spawn a second set of subprocesses to compute an
   * answer the first is already computing.
   */
  read(options?: { readonly refresh?: boolean }): Promise<readonly ServerProfile[]>;
  /** Drop what is cached. Called when profiles change under the server. */
  invalidate(): void;
}

export function createCatalogue(options: CatalogueOptions): Catalogue {
  const { source } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOGUE_TTL_MS;
  const now = options.now ?? (() => Date.now());

  let cached: { readonly at: number; readonly profiles: readonly ServerProfile[] } | null = null;
  let inFlight: Promise<readonly ServerProfile[]> | null = null;

  async function build(): Promise<readonly ServerProfile[]> {
    const [profiles, providers] = await Promise.all([
      source.listProfiles(),
      source.listProviders(),
    ]);

    const descriptors = new Map<ProviderId, ProviderDescriptor>(
      providers.map((descriptor) => [descriptor.id, descriptor]),
    );
    const slugs = assignProfileSlugs(profiles);

    // Concurrently, because each of these is a subprocess spawn and they are
    // independent. `listModels` does not throw by contract, but a broken
    // adapter still must not take the whole catalogue down with it — a route
    // list missing one account is an answer, an HTTP 500 is not.
    const built = await Promise.all(
      profiles.map(async (profile): Promise<ServerProfile> => {
        const descriptor = descriptors.get(profile.providerId);
        const slug = slugs.get(profile.id) ?? profile.id;

        /*
         * Asked alongside the model list, not after it. Both spawn a
         * subprocess for the same account, and serialising them would double
         * the wall-clock of a cold catalogue for no reason — the two questions
         * are independent.
         */
        const authPromise: Promise<AuthStatusInfo | undefined> =
          source.checkAuth === undefined
            ? Promise.resolve(undefined)
            : source
                .checkAuth({ providerId: profile.providerId, profileId: profile.id })
                .catch((error: unknown) => ({
                  // A probe that threw is not a signed-out account. Documented
                  // as never throwing, but this is a subprocess on a path that
                  // must answer, so the contract is enforced rather than
                  // trusted.
                  loggedIn: false,
                  error: error instanceof Error ? error.message : String(error),
                }));

        const fallback: readonly ProviderModelOption[] = descriptor?.models ?? [];
        let models = fallback;
        let live = false;
        try {
          const catalogue = await source.listModels({
            providerId: profile.providerId,
            profileId: profile.id,
          });
          live = catalogue.live;
          /*
           * An *unconfirmed* empty answer is a failure to enumerate, not an
           * empty account — so the descriptor's built-in list stands.
           *
           * The `live` check is what keeps that from being a lie in the other
           * direction. A local endpoint with no model files loaded genuinely
           * has nothing to offer and says so with `live: true`, and overriding
           * *that* with a list of names the endpoint has never heard of would
           * publish routes no client could use.
           *
           * Found by pointing a client at a server whose source could not
           * enumerate: every route vanished, and the honest answer — the names
           * the adapter ships, marked unconfirmed — was already in hand.
           */
          if (catalogue.live || catalogue.models.length > 0) models = catalogue.models;
        } catch {
          // Fall through with the descriptor's static list and `live: false`,
          // which is exactly what the engine would have answered itself.
        }

        const auth = await authPromise;

        return {
          id: profile.id,
          slug,
          label: profile.label,
          provider: {
            id: profile.providerId,
            label: descriptor?.label ?? profile.providerId,
            // Absent means hosted — the same default `ProviderKind` documents.
            kind: descriptor?.kind ?? 'hosted',
          },
          available: descriptor?.available ?? false,
          ...(descriptor === undefined
            ? { unavailableReason: 'No adapter is registered for this provider.' }
            : descriptor.unavailableReason === undefined
              ? {}
              : { unavailableReason: descriptor.unavailableReason }),
          disabled: profile.disabled === true,
          live,
          ...(auth === undefined ? {} : { auth }),
          capabilities: honourableModes(
            descriptor?.capabilities ?? EMPTY_CAPABILITIES,
            profile.providerId,
          ),
          ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
          models: models.map((model) =>
            toServerModel({ model, profile, slug, descriptor }),
          ),
        };
      }),
    );

    return built;
  }

  return {
    async read(readOptions) {
      const fresh =
        readOptions?.refresh !== true && cached !== null && now() - cached.at < ttlMs;
      if (fresh && cached !== null) return cached.profiles;

      if (inFlight !== null) return inFlight;

      inFlight = build()
        .then((profiles) => {
          cached = { at: now(), profiles };
          return profiles;
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    },

    invalidate() {
      cached = null;
    },
  };
}

/**
 * One model row, with the account folded in.
 *
 * The interesting work is the thinking levels. A provider publishes its whole
 * scale (`effortLevels` on the descriptor) and a *model* may accept only part
 * of it (`effortLevels` on the option, where absent means "all of them" and an
 * empty array means "none"). Publishing the provider's scale unfiltered would
 * offer callers levels their chosen model ignores — the same silent-drop hazard
 * `fastMode` is gated on — so what goes on the wire is the intersection.
 */
function toServerModel(input: {
  readonly model: ProviderModelOption;
  readonly profile: ProfileMetadata;
  readonly slug: string;
  readonly descriptor: ProviderDescriptor | undefined;
}): ServerModel {
  const { model, profile, slug, descriptor } = input;

  const offered = descriptor?.effortLevels ?? [];
  const allowed = model.effortLevels;
  const levels: readonly ServerThinkingLevel[] = offered
    .filter((level) => allowed === undefined || allowed.includes(level.id))
    .map((level) => ({ id: level.id, label: level.label, note: level.note }));

  return {
    route: modelRoute(slug, model.id),
    id: model.id,
    label: model.label,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
    note: model.note,
    profileId: profile.id,
    profileSlug: slug,
    profileLabel: profile.label,
    providerId: profile.providerId,
    thinkingLevels: levels,
    // The three flags are `=== true` rather than truthy on purpose: every one
    // of them is optional upstream, and "absent" has to land as `false` here.
    // A caller reading JSON cannot tell a missing field from a false one, so
    // this is the last place the distinction can be closed honestly.
    adaptiveThinking: model.adaptiveThinking === true,
    fastMode: model.supportsFastMode === true,
    ultracode: model.supportsUltracode === true,
    ...(model.tier === undefined ? {} : { tier: model.tier }),
  };
}

/**
 * The capability descriptor for an account whose provider this build has no
 * adapter for.
 *
 * Everything off, which is the truthful answer: nothing can be done through a
 * provider that is not here. Written out rather than imported from protocol's
 * `NO_CAPABILITIES` only because that constant is typed as the mutable shape
 * and this one is a literal the compiler can keep readonly.
 */
/**
 * Would Claude Code refuse `--dangerously-skip-permissions` on this host?
 *
 * The CLI's own rule, mirrored exactly rather than approximated as "is root":
 * it exits under root *unless* the process says the sandbox is deliberate.
 * `IS_SANDBOX=1` is the opt-in for a container whose only user is root — the
 * shape of every headless deployment of this server — and
 * `CLAUDE_CODE_BUBBLEWRAP` is what the CLI's own bubblewrap wrapper sets.
 * Either one and the flag is accepted as root. A server given `IS_SANDBOX=1`
 * in its environment can therefore serve the mode again, and the catalogue has
 * to say so, or the wire lies in the other direction: a mode that works,
 * withheld.
 *
 * `getuid` is absent on Windows, where the question does not arise in this
 * form — a desktop-hosted server there is not "root" in the sense any provider
 * CLI checks for. Absent therefore reads as "not refused", which is the answer
 * that changes nothing.
 */
function hostRefusesBypass(): boolean {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!root) return false;
  if (process.env.IS_SANDBOX === '1') return false;
  if (process.env.CLAUDE_CODE_BUBBLEWRAP) return false;
  return true;
}

/**
 * The permission modes this *host* can actually honour, out of the ones the
 * provider offers.
 *
 * `bypassPermissions` is the only one that depends on more than the adapter.
 * Claude Code refuses `--dangerously-skip-permissions` outright when it is
 * running as root — "cannot be used with root/sudo privileges for security
 * reasons", exit 1 — and the containerised server runs as root, so the mode
 * was advertised, chosen, sent, and then killed the run on spawn. The desktop
 * had no way to know: the capability list said the mode was available, because
 * until now nothing asked whether the machine underneath agreed.
 *
 * Filtered here so the wire tells the truth: `GET /api/v0/profiles` is what a
 * client reads to learn what an account can do, and a list that names a mode
 * the host will kill on spawn is a list that lies. Today the desktop picker
 * still draws its modes from the `artemis` adapter's static descriptor rather
 * than from this — so this is the server's half of the answer, and the run
 * itself still fails with the CLI's own reason (carried since 2.4.7) until the
 * picker learns to intersect the two. The lasting fix is not to run the server
 * as root at all, at which point this filter has nothing to remove; until then
 * `IS_SANDBOX=1` in the server's environment is the CLI's own way of saying the
 * container is the sandbox, and this filter steps aside for it the same way
 * the CLI does.
 */
function honourableModes(
  capabilities: Capabilities,
  providerId: ProviderId,
): Capabilities {
  if (providerId !== 'claude' || !hostRefusesBypass()) return capabilities;
  if (!capabilities.permissionModes.includes('bypassPermissions')) return capabilities;
  return {
    ...capabilities,
    permissionModes: capabilities.permissionModes.filter(
      (mode) => mode !== 'bypassPermissions',
    ),
  };
}

const EMPTY_CAPABILITIES = {
  interactivePermissions: false,
  partialMessages: false,
  midRunSteering: false,
  forkSession: false,
  listSessions: false,
  subagents: false,
  subagentTranscripts: false,
  renameSession: false,
  deleteSession: false,
  tagSession: false,
  permissionModes: [],
  resumeSession: false,
  rewind: false,
  usageReporting: false,
  costReporting: false,
  planUsageReporting: false,
  systemPromptAppend: false,
  imageInput: false,
  fileInput: false,
} as const;
