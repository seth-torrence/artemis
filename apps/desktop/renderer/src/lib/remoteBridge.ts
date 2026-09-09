/**
 * The remote bridge: `window.artemis`, served by another machine (ADR 0004).
 * ============================================================================
 *
 * A drop-in fourth answer to `resolveBridge()`. Every namespace the renderer
 * already speaks is implemented here over HTTP against a serving Artemis —
 * the run list is `GET /api/v0/runs`, the live feed is the SSE event stream,
 * a permission answer is a POST — so the entire existing UI renders the
 * remote machine without learning a second vocabulary. The mock bridge
 * proved the interface is implementable without Electron; this is the same
 * proof with a network attached.
 *
 * Three rules shape what is real and what degrades:
 *
 *  1. **Runs, sessions and terminals cross the wire.** They are data and
 *     verbs, and the server serves them. Anything the server refuses (an
 *     older build, an observe-only phase) surfaces as the refusal it sent —
 *     a sentence, not a hang.
 *
 *  2. **Local machinery stays local.** Window chrome, app updates, the menu
 *     and the prefs file describe the window the user is sitting at, not the
 *     machine they are looking at — so they delegate to the *local* preload
 *     bridge when one exists (production) and stub benignly when none does
 *     (dev against the mock). Nothing about the local window should change
 *     because the conversation lives elsewhere.
 *
 *  3. **What cannot cross the wire degrades absent-with-reason.** The
 *     browser dock is a `WebContentsView` composited over the serving
 *     machine's window; previews and file reads reach the serving machine's
 *     disk through channels this surface deliberately does not have; native
 *     dialogs open on the wrong machine's screen. Each answers with a
 *     sentence naming the constraint, through the same failure paths the
 *     existing UI already renders — a transcript note, a disabled control —
 *     never a silent no-op.
 *
 * The token rides in `Authorization` on every request and never in a URL,
 * where it would land in the access log of every proxy on the path.
 */

import type {
  AgentEvent,
  ArtemisBridge,
  IpcResult,
  ProfileMetadata,
  ProviderDescriptor,
  ProviderEffortOption,
  ProviderModelOption,
  RemoteGapPayload,
  RunsListResponse,
  ServerConnectionInfo,
  ServerErrorBody,
  ServerLiveWorkBody,
  ServerModel,
  ServerProfile,
  ServerRunBody,
  ServerRunEventsBody,
  ServerRunInterruptBody,
  ServerRunPermissionBody,
  ServerRunsBody,
  ServerRunSendBody,
  ServerSessionMessagesBody,
  ServerSessionsBody,
  ServerSessionSummary,
  ServerTerminalBody,
  ServerTerminalReplayBody,
  ServerTerminalsBody,
  SessionSummary,
  TerminalEvent,
  UpdateState,
  WindowState,
} from '@rx-artemis/protocol';
import {
  createSseDecoder,
  REMOTE_EVENTS_PATH,
  REMOTE_LIVE_WORK_PATH,
  REMOTE_RUNS_PATH,
  REMOTE_STREAM_GAP,
  REMOTE_STREAM_HELLO,
  REMOTE_TERMINALS_PATH,
  remoteRunPath,
  remoteTerminalPath,
  SERVER_API_VERSION,
} from '@rx-artemis/protocol';

import { describeRemote, type RemoteBridgeConfig } from './remoteConfig';

/* -------------------------------------------------------------------------- */
/* Result helpers                                                             */
/* -------------------------------------------------------------------------- */

const ok = <T,>(value: T): IpcResult<T> => ({ ok: true, value });

/** A capability that deliberately does not cross the wire. */
const absent = <T,>(message: string): IpcResult<T> => ({
  ok: false,
  error: { code: 'invalid_request', message },
});

const BROWSER_REASON =
  'The browser dock renders in the serving machine’s own window and does not cross the remote wire.';
const FILES_REASON =
  'That file lives on the serving machine, and this connection has no channel for reading its disk.';
const LOCAL_SETTINGS_REASON =
  'That is managed on the serving machine itself, in its own Settings.';
const SERVER_ACCOUNTS_REASON =
  'Signing a server’s accounts in is driven from a desktop Artemis holding that server’s connection, not from a window already served by it.';
const DIALOG_REASON =
  'A native dialog would open on this machine and pick a folder the serving machine cannot see.';

/* -------------------------------------------------------------------------- */
/* The bridge                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the bridge for one configured connection.
 *
 * `local` is the preload bridge when this window has one — rule 2 above. The
 * returned object is complete from the first tick; everything network-backed
 * resolves lazily behind its promises.
 */
export function createRemoteBridge(
  config: RemoteBridgeConfig,
  local: ArtemisBridge | null,
  options: {
    /**
     * Ends the event-stream pump. Production passes nothing — the binding
     * lives exactly as long as the window and leaving remote mode is a reload
     * — but a test that builds several bridges needs the earlier ones' pumps
     * to stop consuming its scripted responses.
     */
    readonly signal?: AbortSignal;
  } = {},
): ArtemisBridge {
  const origin = config.origin.replace(/\/+$/, '');
  const authorization = `Bearer ${config.token}`;
  const ended = (): boolean => options.signal?.aborted === true;

  /* ------------------------------------------------------------------ */
  /* Transport                                                          */
  /* ------------------------------------------------------------------ */

  async function http<T>(
    path: string,
    init: { readonly method?: string; readonly body?: unknown } = {},
  ): Promise<IpcResult<T>> {
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'transport',
          message: `Could not reach ${describeRemote(config)}: ${
            cause instanceof Error ? cause.message : 'the request failed'
          }. Is the tailnet up?`,
          retryable: true,
        },
      };
    }

    let body: unknown = undefined;
    try {
      body = await response.json();
    } catch {
      // A body-less reply to a failed request still deserves a sentence.
    }

    if (!response.ok) {
      const serverError = (body as Partial<ServerErrorBody> | undefined)?.error;
      return {
        ok: false,
        error: {
          code:
            response.status === 401 || response.status === 403
              ? 'auth'
              : response.status >= 500 && response.status !== 501
                ? 'provider_unavailable'
                : 'invalid_request',
          message:
            serverError?.message ??
            `${describeRemote(config)} answered ${String(response.status)}.`,
          retryable: response.status >= 500,
        },
      };
    }

    return ok(body as T);
  }

  /* ------------------------------------------------------------------ */
  /* The catalogue, read once and shared                                */
  /* ------------------------------------------------------------------ */

  const CATALOGUE_TTL_MS = 60_000;
  let cataloguePromise: Promise<IpcResult<readonly ServerProfile[]>> | null = null;
  let catalogueAt = 0;

  function catalogue(refresh = false): Promise<IpcResult<readonly ServerProfile[]>> {
    const stale = Date.now() - catalogueAt > CATALOGUE_TTL_MS;
    if (cataloguePromise === null || refresh || stale) {
      catalogueAt = Date.now();
      cataloguePromise = http<{ profiles: readonly ServerProfile[] }>(
        `/api/${SERVER_API_VERSION}/profiles${refresh ? '?refresh=1' : ''}`,
      ).then((result) => {
        // A failed read is returned to its caller and not cached: the next
        // caller should retry rather than inherit a network blip forever.
        if (!result.ok) cataloguePromise = null;
        return result.ok ? ok(result.value.profiles) : result;
      });
    }
    return cataloguePromise;
  }

  let connectionPromise: Promise<IpcResult<ServerConnectionInfo>> | null = null;
  function connectionInfo(): Promise<IpcResult<ServerConnectionInfo>> {
    connectionPromise ??= http<ServerConnectionInfo>(`/api/${SERVER_API_VERSION}/connection`).then(
      (result) => {
        if (!result.ok) connectionPromise = null;
        return result;
      },
    );
    return connectionPromise;
  }

  /**
   * Is this the far machine's own directory — the pin, or inside it?
   *
   * Lexical on purpose, like the server's own `confineToRoot`: the question
   * here is only "did this path come from the serving side" (the chooser
   * hands out the pin verbatim), not "is it safe" — the server still confines
   * whatever is sent. Anything unanswerable — no cwd, a non-POSIX shape, a
   * connection read that failed, a pin that is not a directory — answers
   * `false`, and a `false` cwd is omitted from the wire, which roots the run
   * at the pin: the safest thing a wrong-machine path could become.
   */
  async function cwdBelongsToPin(cwd: string | undefined): Promise<boolean> {
    if (cwd === undefined || !cwd.startsWith('/')) return false;
    const info = await connectionInfo();
    if (!info.ok || info.value.workspace.kind !== 'directory') return false;
    const root = info.value.workspace.path;
    return cwd === root || cwd.startsWith(`${root}/`);
  }

  /* ------------------------------------------------------------------ */
  /* The event stream                                                   */
  /* ------------------------------------------------------------------ */

  const agentListeners = new Set<(event: AgentEvent) => void>();
  const terminalListeners = new Set<(event: TerminalEvent) => void>();

  /**
   * The resume cursor: the highest feed seq this window has applied, or null
   * before the first hello. Sent as `Last-Event-ID` on every reconnect, which
   * is what makes a Wi-Fi blip a replay rather than a hole — and what keeps
   * the server's deliberate interrupt-on-disconnect from reading a blip as a
   * departure: the stream is re-attached long before the server's grace
   * window closes.
   */
  let lastSeq: number | null = null;

  function dispatch(message: { id?: string; event?: string; data: string }): void {
    if (message.event === REMOTE_STREAM_HELLO) {
      try {
        const hello = JSON.parse(message.data) as { seq?: number };
        // Only when this window has no cursor yet: a reconnect keeps its own,
        // which is behind the head by exactly the replay now arriving.
        if (lastSeq === null && typeof hello.seq === 'number') lastSeq = hello.seq;
      } catch {
        // A malformed hello costs the cursor's starting point, nothing more.
      }
      return;
    }

    if (message.event === REMOTE_STREAM_GAP) {
      /*
       * The server is telling us events are unrecoverably gone. Nothing to
       * re-request here: the renderer already owns the recovery — the stall
       * sweep compares each handle's `lastSeq` against what the pane applied
       * and re-pulls `runs:events` per run — so the honest response is to
       * advance the cursor past the hole and let that machinery heal the
       * transcripts, rather than pretending the stream was continuous.
       */
      try {
        const gap = JSON.parse(message.data) as Partial<RemoteGapPayload>;
        if (typeof gap.firstSeq === 'number') lastSeq = Math.max(lastSeq ?? 0, gap.firstSeq - 1);
      } catch {
        // An unreadable gap notice changes nothing the sweep will not fix.
      }
      return;
    }

    if (message.id !== undefined && /^\d+$/.test(message.id)) lastSeq = Number(message.id);

    if (message.event === 'artemis:push:agent-event') {
      try {
        const event = JSON.parse(message.data) as AgentEvent;
        for (const listener of [...agentListeners]) listener(event);
      } catch {
        // One malformed frame must not kill the feed.
      }
      return;
    }

    if (message.event === 'artemis:push:terminal-event') {
      try {
        const event = JSON.parse(message.data) as TerminalEvent;
        for (const listener of [...terminalListeners]) listener(event);
      } catch {
        // As above.
      }
    }
  }

  /**
   * Read the stream for as long as the binding lives, reconnecting with
   * backoff.
   *
   * Backoff caps at five seconds — far inside the server's
   * interrupt-on-disconnect grace, so a dropped socket costs a few seconds of
   * replay, never a stopped run.
   */
  async function pump(): Promise<void> {
    let failures = 0;
    while (!ended()) {
      try {
        const response = await fetch(`${origin}${REMOTE_EVENTS_PATH}`, {
          headers: {
            authorization,
            accept: 'text/event-stream',
            ...(lastSeq === null ? {} : { 'last-event-id': String(lastSeq) }),
          },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (!response.ok || response.body === null) {
          throw new Error(`the event stream answered ${String(response.status)}`);
        }
        failures = 0;
        const decoder = createSseDecoder();
        const text = new TextDecoder();
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || ended()) break;
          for (const message of decoder.feed(text.decode(value, { stream: true }))) {
            dispatch(message);
          }
        }
      } catch {
        // Fall through to the retry below; the cursor survives.
      }
      if (ended()) break;
      failures += 1;
      const delay = Math.min(500 * 2 ** Math.min(failures - 1, 4), 5_000);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  void pump();

  /* ------------------------------------------------------------------ */
  /* Catalogue → renderer shapes                                        */
  /* ------------------------------------------------------------------ */

  function toProfileMetadata(profile: ServerProfile): ProfileMetadata {
    return {
      id: profile.id,
      label: profile.label,
      providerId: profile.provider.id,
      // The remote store's directory is a fact about the serving machine's
      // disk that this surface deliberately cannot see. Empty rather than
      // invented; every write that would need it degrades with a reason.
      configDir: '',
      ...(profile.disabled ? { disabled: true } : {}),
    };
  }

  function toModelOption(model: ServerModel): ProviderModelOption {
    return {
      id: model.id,
      label: model.label,
      ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
      ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
      note: model.note,
      effortLevels: model.thinkingLevels.map((level) => level.id),
      ...(model.fastMode ? { supportsFastMode: true } : {}),
      ...(model.ultracode ? { supportsUltracode: true } : {}),
      ...(model.adaptiveThinking ? { adaptiveThinking: true } : {}),
      ...(model.tier === undefined ? {} : { tier: model.tier }),
    };
  }

  /** Thinking levels across a profile's models, deduplicated in first-seen order. */
  function effortOptions(profile: ServerProfile): readonly ProviderEffortOption[] {
    const seen = new Map<string, ProviderEffortOption>();
    for (const model of profile.models) {
      for (const level of model.thinkingLevels) {
        if (!seen.has(level.id)) {
          seen.set(level.id, { id: level.id, label: level.label, note: level.note });
        }
      }
    }
    return [...seen.values()];
  }

  /**
   * One descriptor per provider present in the catalogue.
   *
   * The serving machine's registry is not enumerable from here, so providers
   * with no serving account simply do not appear — a remote window offers
   * what the machine actually serves, which is the catalogue's own rule
   * ("hidden, not merely refused" applies to the connection's allowance too).
   */
  function toDescriptors(profiles: readonly ServerProfile[]): readonly ProviderDescriptor[] {
    const byProvider = new Map<string, ServerProfile[]>();
    for (const profile of profiles) {
      const group = byProvider.get(profile.provider.id) ?? [];
      group.push(profile);
      byProvider.set(profile.provider.id, group);
    }
    return [...byProvider.values()].map((group) => {
      const exemplar = group.find((profile) => profile.available) ?? group[0] as ServerProfile;
      return {
        id: exemplar.provider.id,
        kind: exemplar.provider.kind,
        label: exemplar.provider.label,
        capabilities: exemplar.capabilities,
        models: exemplar.models.map(toModelOption),
        effortLevels: effortOptions(exemplar),
        available: group.some((profile) => profile.available),
        ...(group.some((profile) => profile.available)
          ? {}
          : { unavailableReason: exemplar.unavailableReason ?? 'Unavailable on the serving machine.' }),
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Local delegation                                                   */
  /* ------------------------------------------------------------------ */

  const stubWindowState = (): WindowState => ({
    maximized: false,
    fullScreen: false,
    focused: typeof document === 'undefined' ? true : document.hasFocus(),
  });

  const idleUpdateState = (): UpdateState => ({
    phase: 'idle',
    version: null,
    message: null,
    releaseUrl: null,
    progress: null,
  });

  /* ------------------------------------------------------------------ */
  /* The surface                                                        */
  /* ------------------------------------------------------------------ */

  return {
    // The local app's version — it is the software actually running — with
    // the mode visible the way the mock's `-mock` suffix is: this bridge
    // never masquerades as a plain local one.
    version: `${local?.version ?? '0.0.0'}+remote`,
    platform: local?.platform ?? 'darwin',
    // The architecture of the machine the *window* is on, like `platform`
    // beside it: About reports the build the user is looking at, and the
    // updater that would replace it is the local one. `other` when there is no
    // local bridge to ask, which is the same "no answer" the fallbacks above
    // give rather than a guess.
    arch: local?.arch ?? 'other',

    profiles: {
      list: async (request) => {
        const read = await catalogue();
        if (!read.ok) return read;
        const profiles = read.value
          .filter(
            (profile) =>
              request.providerId === undefined || profile.provider.id === request.providerId,
          )
          .map(toProfileMetadata);
        return ok({ profiles });
      },
      create: async () => absent('Accounts are managed on the serving machine.'),
      update: async () => absent('Accounts are managed on the serving machine.'),
      remove: async () => absent('Accounts are managed on the serving machine.'),
      suggestDir: async () => absent('Accounts are managed on the serving machine.'),
    },

    providers: {
      list: async (request) => {
        const read = await catalogue(request.refresh === true);
        return read.ok ? ok({ providers: toDescriptors(read.value) }) : read;
      },
      models: async (request) => {
        const read = await catalogue();
        if (!read.ok) return read;
        const profile = read.value.find((candidate) => candidate.id === request.profileId);
        if (profile === undefined) {
          return absent('No such account on the serving machine.');
        }
        return ok({ models: profile.models.map(toModelOption), live: profile.live });
      },
      // The serving machine's command discovery would need its provider CLI
      // and its working directory; an empty list is the contract's ordinary
      // "menu stays shut until the first message".
      commands: async () => ok({ commands: [] }),
    },

    runs: {
      start: async (request) => {
        /*
         * The cwd is the serving machine's to spell, and the pin's to
         * permit. A pane that has lived locally holds this window's own
         * directory — a Windows path names the wrong computer outright, and
         * a Mac's POSIX path only *looks* like the right shape while still
         * naming the wrong disk (`/Users/me/app` posted at a `/srv/work`
         * pin earns a 403 on the first prompt). The only cwd worth sending
         * is one already inside the connection's pin — this bridge's own
         * chooser can produce nothing else — so anything outside it is left
         * off the wire and the pin decides where the run roots.
         */
        const { cwd, ...rest } = request.input;
        const input = (await cwdBelongsToPin(cwd)) ? request.input : rest;
        const reply = await http<ServerRunBody>(REMOTE_RUNS_PATH, {
          method: 'POST',
          body: { input },
        });
        return reply.ok ? ok({ run: reply.value.run }) : reply;
      },
      send: async (request) => {
        const reply = await http<ServerRunSendBody>(remoteRunPath(request.runId, 'send'), {
          method: 'POST',
          body: {
            text: request.text,
            ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
          },
        });
        return reply.ok
          ? ok({ runId: request.runId, deliveredImmediately: reply.value.deliveredImmediately })
          : reply;
      },
      interrupt: async (request) => {
        const reply = await http<ServerRunInterruptBody>(
          remoteRunPath(request.runId, 'interrupt'),
          { method: 'POST', body: {} },
        );
        return reply.ok
          ? ok({ runId: request.runId, stillQueued: reply.value.stillQueued })
          : reply;
      },
      stopTask: async (request) => {
        const reply = await http<unknown>(remoteRunPath(request.runId, 'stop-task'), {
          method: 'POST',
          body: { taskId: request.taskId },
        });
        return reply.ok ? ok({ runId: request.runId, taskId: request.taskId }) : reply;
      },
      respondToPermission: async (request) => {
        const reply = await http<ServerRunPermissionBody>(
          remoteRunPath(request.runId, 'respond-permission'),
          { method: 'POST', body: { requestId: request.requestId, decision: request.decision } },
        );
        return reply.ok ? ok({ requestId: request.requestId }) : reply;
      },
      dispose: async (request) => {
        const reply = await http<unknown>(remoteRunPath(request.runId, 'dispose'), {
          method: 'POST',
          body: {},
        });
        return reply.ok ? ok({ runId: request.runId }) : reply;
      },
      list: async (request) => {
        const reply = await http<ServerRunsBody>(REMOTE_RUNS_PATH);
        if (!reply.ok) return reply;
        const runs =
          request.cwd === undefined
            ? reply.value.runs
            : reply.value.runs.filter((run) => run.cwd === request.cwd);
        return ok({ runs } satisfies RunsListResponse);
      },
      liveWork: async () => {
        const reply = await http<ServerLiveWorkBody>(REMOTE_LIVE_WORK_PATH);
        // "Known to be working" is allowed to be empty and is never "the rest
        // are finished" — so a server too old for the route degrades to the
        // same safe answer instead of erroring every poll.
        if (!reply.ok) return ok({ sessionIds: [], working: [], delegated: [] });
        const { sessionIds, working, delegated } = reply.value;
        return ok({ sessionIds, working, delegated });
      },
      events: async (request) => {
        const suffix = request.afterSeq === undefined ? '' : `?after=${String(request.afterSeq)}`;
        const reply = await http<ServerRunEventsBody>(
          `${remoteRunPath(request.runId, 'events')}${suffix}`,
        );
        return reply.ok
          ? ok({ runId: request.runId, events: reply.value.events, truncated: reply.value.truncated })
          : reply;
      },
      onEvent: (listener) => {
        agentListeners.add(listener);
        return () => {
          agentListeners.delete(listener);
        };
      },
      // Suggestions are generated after `run.end` on the serving machine and
      // do not ride the stream yet; a composer with no suggestion is the
      // documented cold state, not a failure.
      onSuggestion: () => () => undefined,
    },

    /*
     * The serving machine's conversations, in this window's own sidebar.
     *
     * -----------------------------------------------------------------------
     * WHAT THIS CONNECTION IS ALLOWED TO SEE
     * -----------------------------------------------------------------------
     *
     * Not "every session on that machine" — the ledger's pin decides, and the
     * server applies it before answering. What comes back is the conversations
     * *this connection's family* created: the token's own, and those of any
     * other token pinned to the same directory, which is the multi-device case
     * the pin was designed for. The serving desktop's own private history is
     * not on this list and no parameter here can widen it.
     *
     * -----------------------------------------------------------------------
     * WHY BOTH LISTS ARE ONE REQUEST
     * -----------------------------------------------------------------------
     *
     * Locally, `list` reads one (profile × directory) partition off disk and
     * `listAll` walks the whole store, so they are genuinely different costs.
     * Here the server has already done the walking — the ledger *is* the
     * index, and it is scoped — so the wire has exactly one answer and the two
     * calls differ only in how it is filtered. `list` narrows to the
     * provider/profile/directory it was asked for; `listAll` returns the lot,
     * newest first, which is what the sidebar wants.
     */
    sessions: (() => {
      const read = async (): Promise<IpcResult<readonly ServerSessionSummary[]>> => {
        const reply = await http<ServerSessionsBody>(`/api/${SERVER_API_VERSION}/sessions`);
        // A serving build with no session history answers 501, and an empty
        // sidebar is the honest rendering of "this machine keeps none" — the
        // same cold state a store with nothing in it produces.
        return reply.ok ? ok(reply.value.sessions) : ok([]);
      };

      /*
       * A server row, as the sidebar's own type.
       *
       * The fields the wire does not carry are *omitted*, never invented.
       * `titleIsCustom` would be a claim about how the title was made,
       * `messageCount` a number nobody counted, `gitBranch` a fact about a
       * checkout on another machine — and a sidebar rendering an invented
       * value is worse than one rendering none. `title` is already resolved
       * server-side by the same preference order the local adapters use.
       */
      /*
       * A server row, as the sidebar's own type — degrading where the server is
       * older than the fields this asks for.
       *
       * `profileId`/`providerId` were added to the wire with remote sessions,
       * so a newer client can meet a server that sends neither. Two wrong
       * answers were available and both are refused here: casting `undefined`
       * into a branded id puts a lie in the row that everything downstream then
       * trusts, and dropping every row without them makes the sidebar silently
       * empty against a server that is working perfectly. Instead the ids are
       * omitted and the row carries `profileIsUnknown` — the protocol's own
       * word for "this account is a guess, show no account" — which the sidebar
       * already knows how to render.
       */
      const toSummary = (row: ServerSessionSummary): SessionSummary => ({
        id: row.id as SessionSummary['id'],
        // The branded ids are empty strings rather than absent when the server
        // did not say: `SessionSummary` requires both, and an empty id matches
        // no account, which is exactly what `profileIsUnknown` then explains.
        providerId: (row.providerId ?? '') as SessionSummary['providerId'],
        profileId: (row.profileId ?? '') as SessionSummary['profileId'],
        ...(row.profileId === undefined ? { profileIsUnknown: true as const } : {}),
        cwd: row.cwd,
        title: row.title,
        ...(row.firstPrompt === undefined ? {} : { firstPrompt: row.firstPrompt }),
        updatedAt: row.updatedAt,
      });

      const sorted = (rows: readonly ServerSessionSummary[]): SessionSummary[] =>
        [...rows].sort((a, b) => b.updatedAt - a.updatedAt).map(toSummary);

      return {
        list: async (request) => {
          const rows = await read();
          if (!rows.ok) return rows;
          /*
           * An unattributed row matches on directory alone.
           *
           * Against an older server every row is unattributed, so demanding an
           * id match would return nothing for every query — a silently empty
           * project history against a server whose sessions are all there. The
           * directory is the field such a server does send, and it is the one
           * this query is really about.
           */
          const matching = rows.value.filter(
            (row) =>
              row.cwd === request.cwd &&
              (row.providerId === undefined || row.providerId === String(request.providerId)) &&
              (row.profileId === undefined || row.profileId === String(request.profileId)),
          );
          return ok({ sessions: sorted(matching), hasMore: false });
        },
        listAll: async (request) => {
          const rows = await read();
          if (!rows.ok) return rows;
          const matching =
            request.providerId === undefined
              ? rows.value
              : rows.value.filter(
                  (row) =>
                    row.providerId === undefined ||
                    row.providerId === String(request.providerId),
                );
          return ok({ sessions: sorted(matching), hasMore: false });
        },
        messages: async (request) => {
          const reply = await http<ServerSessionMessagesBody>(
            `/api/${SERVER_API_VERSION}/sessions/${encodeURIComponent(String(request.sessionId))}/messages`,
          );
          if (!reply.ok) return reply;
          /*
           * Re-stamped with the caller's run id.
           *
           * The server replays under a synthetic id of its own — it has no
           * idea which pane is asking — and the transcript this is about to
           * join is keyed on the run. Restamping here rather than asking the
           * server to accept an id keeps a client from choosing what another
           * client's events are labelled with.
           */
          const events = reply.value.events.map((event) => ({
            ...event,
            runId: request.runId,
          })) as readonly AgentEvent[];
          return ok({ events, hasMore: reply.value.hasMore });
        },
        subagentMessages: async () =>
          absent('Subagent transcripts do not cross the remote wire.'),
        rename: async () => absent(LOCAL_SETTINGS_REASON),
        delete: async () => absent(LOCAL_SETTINGS_REASON),
        tag: async () => absent(LOCAL_SETTINGS_REASON),
      };
    })(),

    workspace: {
      pickDirectory: async () => {
        // The one directory this connection can honestly offer is its own
        // pin: the folder the token was bound to when it was minted.
        const info = await connectionInfo();
        if (!info.ok) return info;
        if (info.value.workspace.kind === 'directory') {
          return ok({ path: info.value.workspace.path });
        }
        return absent(DIALOG_REASON);
      },
      describe: async (request) => {
        // A pure naming fallback: the serving machine's repositories are not
        // walkable from here, so the directory's own name is the honest
        // answer and the header renders it exactly as it would a plain
        // folder.
        const segments = request.path.split('/').filter((part) => part.length > 0);
        return ok({ path: request.path, name: segments.at(-1) ?? request.path });
      },
      // The repository is on the serving machine and `git` would have to run
      // there. Refusing is the honest answer and the one the chip's menu can
      // show as a reason; a worktree made on *this* machine would be a
      // directory the run can never reach.
      createWorktree: async () =>
        absent('Worktrees are made on the serving machine, which this connection cannot reach.'),
    },

    sharedConfig: {
      status: async () => ok({ root: '', rootMissing: [], dirs: [] }),
    },

    memoryBanks: {
      status: async () =>
        ok({ cliAvailable: false, masterEnabled: false, banks: [], profiles: [] }),
      memories: async () => absent(LOCAL_SETTINGS_REASON),
      preflight: async () =>
        ok({
          ready: false,
          checks: [
            {
              id: 'remote',
              label: 'Remote connection',
              state: 'fail' as const,
              detail: 'Memory banks live on the serving machine and are managed there.',
              remedy: null,
            },
          ],
        }),
      add: async () => absent(LOCAL_SETTINGS_REASON),
      // Verification is a `git ls-remote` run from the machine that would do
      // the cloning, and that machine is the serving one. Answering from here
      // would test this computer's credentials against a remote it will never
      // fetch.
      verifyRemote: async () => absent(LOCAL_SETTINGS_REASON),
      sync: async () => absent(LOCAL_SETTINGS_REASON),
      retire: async () => absent(LOCAL_SETTINGS_REASON),
      setEnabled: async () => absent(LOCAL_SETTINGS_REASON),
      forget: async () => absent(LOCAL_SETTINGS_REASON),
      setMasterEnabled: async () => absent(LOCAL_SETTINGS_REASON),
    },

    /*
     * Absent rather than empty, which is the one place this namespace differs
     * from `memoryBanks` above.
     *
     * A bank list can honestly answer "none here" for a machine with no CLI.
     * A key-manager list cannot: the serving machine may well have several,
     * and its runs are resolving references against them right now. Answering
     * `[]` would be this window claiming to have looked. So every method says
     * where the answer lives instead, including the reads — the pane renders
     * that sentence, and a sentence is what the user needs.
     *
     * The two that could in principle cross the wire — a TLS handshake and a
     * reference test — deliberately do not. Both would run from *this*
     * computer, against a vault only the serving machine can reach and with a
     * credential only the serving machine holds, so a green answer here would
     * be evidence about the wrong machine.
     */
    secrets: {
      listConnections: async () => absent(LOCAL_SETTINGS_REASON),
      saveConnection: async () => absent(LOCAL_SETTINGS_REASON),
      deleteConnection: async () => absent(LOCAL_SETTINGS_REASON),
      verifyConnection: async () => absent(LOCAL_SETTINGS_REASON),
      fetchServerCert: async () =>
        absent('The handshake would run from this computer, not from the machine that will use it.'),
      testRef: async () =>
        absent('A reference resolves on the machine whose runs need it, with the credential it holds.'),
    },

    agentPrompts: {
      list: async () =>
        absent('Standing instructions are composed on the serving machine, where runs start.'),
      save: async () =>
        absent('Standing instructions are composed on the serving machine, where runs start.'),
    },

    preview: {
      open: async () => absent(FILES_REASON),
    },

    files: {
      read: async () => absent(FILES_REASON),
      list: async () => absent(FILES_REASON),
      // An empty subset means no path renders as a link, which is exactly
      // what a machine whose files cannot be opened should show.
      check: async () => ok({ reachable: [] }),
    },

    github: {
      // No `gh` reachable from here; an empty result set leaves every link a
      // link, which is the channel's own contract for "could not answer".
      pullRequests: async () => ok({ results: [] }),
    },

    terminal: {
      start: async (request) => {
        const reply = await http<ServerTerminalBody>(REMOTE_TERMINALS_PATH, {
          method: 'POST',
          body: { cwd: request.cwd, cols: request.cols, rows: request.rows },
        });
        return reply.ok ? ok({ terminal: reply.value.terminal }) : reply;
      },
      write: async (request) => {
        const reply = await http<unknown>(remoteTerminalPath(request.id, 'write'), {
          method: 'POST',
          body: { data: request.data },
        });
        return reply.ok ? ok({ id: request.id }) : reply;
      },
      resize: async (request) => {
        const reply = await http<unknown>(remoteTerminalPath(request.id, 'resize'), {
          method: 'POST',
          body: { cols: request.cols, rows: request.rows },
        });
        return reply.ok ? ok({ id: request.id }) : reply;
      },
      close: async (request) => {
        const reply = await http<unknown>(remoteTerminalPath(request.id, 'close'), {
          method: 'POST',
          body: {},
        });
        return reply.ok ? ok({ id: request.id }) : reply;
      },
      list: async () => {
        const reply = await http<ServerTerminalsBody>(REMOTE_TERMINALS_PATH);
        // A serving build without remote terminals lists none rather than
        // erroring the reload path that asks.
        return reply.ok ? ok({ terminals: reply.value.terminals }) : ok({ terminals: [] });
      },
      replay: async (request) => {
        const reply = await http<ServerTerminalReplayBody>(
          remoteTerminalPath(request.id, 'replay'),
        );
        return reply.ok
          ? ok({ id: request.id, data: reply.value.data, truncated: reply.value.truncated })
          : reply;
      },
      onEvent: (listener) => {
        terminalListeners.add(listener);
        return () => {
          terminalListeners.delete(listener);
        };
      },
    },

    browser: {
      open: async () => absent(BROWSER_REASON),
      navigate: async () => absent(BROWSER_REASON),
      command: async () => absent(BROWSER_REASON),
      layout: async () => absent(BROWSER_REASON),
      close: async () => absent(BROWSER_REASON),
      list: async () => ok({ browsers: [] }),
      onEvent: () => () => undefined,
    },

    usagePlan: {
      // Plan usage is read by spawning provider CLIs on the serving machine,
      // which this surface does not ask for yet. `null` is the documented
      // cold-start answer and renders as "no reading", never as an error.
      cached: async () => ok({ usage: null }),
      refresh: async () => ok({ usage: null }),
      onChange: () => () => undefined,
    },

    auth: {
      status: async (request) => {
        const read = await catalogue();
        if (!read.ok) return read;
        const profile = read.value.find((candidate) => candidate.id === request.profileId);
        if (profile === undefined) return absent('No such account on the serving machine.');
        return ok({
          status: {
            loggedIn: profile.available,
            ...(profile.available ? {} : { error: profile.unavailableReason ?? 'Unavailable.' }),
          },
          signInCommand: '# Sign this account in on the serving machine itself.',
        });
      },
      signOut: async () => absent(LOCAL_SETTINGS_REASON),
    },

    /**
     * Rule 3, and the reason is the shape of the request rather than the
     * network.
     *
     * Every channel here names a *local* Artemis-Server profile — the one that
     * carries the address and the connection token saying which server to
     * administer. A window in remote mode has no such profile: it is already
     * bound to one server, and the accounts it can see are that server's own.
     * There is nothing for `profileId` to mean, so rather than quietly
     * administering whichever machine this window happens to be pointed at,
     * the surface is absent with the sentence that says where the job is done.
     */
    serverAccounts: {
      list: async () => absent(SERVER_ACCOUNTS_REASON),
      create: async () => absent(SERVER_ACCOUNTS_REASON),
      update: async () => absent(SERVER_ACCOUNTS_REASON),
      delete: async () => absent(SERVER_ACCOUNTS_REASON),
      signIn: async () => absent(SERVER_ACCOUNTS_REASON),
      signInStatus: async () => absent(SERVER_ACCOUNTS_REASON),
      submitCode: async () => absent(SERVER_ACCOUNTS_REASON),
      cancelSignIn: async () => absent(SERVER_ACCOUNTS_REASON),
    },

    /*
     * Rule 2: the window, the updater, the menu, the prefs file and the
     * remote-origin grant all describe the machine the user is sitting at.
     * Delegated to the local preload bridge when one exists; stubbed with the
     * mock's own honest fallbacks when none does.
     */
    window: local?.window ?? {
      minimize: async () => ok({ state: stubWindowState() }),
      toggleMaximize: async () => ok({ state: stubWindowState() }),
      close: async () => ok({ state: stubWindowState() }),
      state: async () => ok({ state: stubWindowState() }),
      onStateChange: () => () => undefined,
    },

    updates: local?.updates ?? {
      state: async () => ok({ state: idleUpdateState() }),
      // `unsupported` rather than `unreachable`: with no local bridge there is
      // no updater to ask and no request is made, which is exactly the
      // distinction the outcome exists to draw. A remote window reporting a
      // network failure would send someone to debug a connection that was
      // never used.
      check: async () => ok({ outcome: 'unsupported', state: idleUpdateState() }),
      install: async () => ok({ state: idleUpdateState() }),
      restart: async () => ok({ state: idleUpdateState() }),
      dismiss: async () => ok({ state: idleUpdateState() }),
      setChannel: async () => ok({ state: idleUpdateState() }),
      onChange: () => () => undefined,
    },

    prefsFile: local?.prefsFile ?? {
      read: () => globalThis.localStorage?.getItem('artemis.prefs.v1') ?? null,
      write: (json: string) => {
        try {
          globalThis.localStorage?.setItem('artemis.prefs.v1', json);
        } catch {
          // A full quota is not worth an error over a preference.
        }
      },
    },

    menu: local?.menu ?? {
      onOpenSettings: () => () => undefined,
    },

    server: {
      status: async () => absent(LOCAL_SETTINGS_REASON),
      start: async () => absent(LOCAL_SETTINGS_REASON),
      stop: async () => absent(LOCAL_SETTINGS_REASON),
      configure: async () => absent(LOCAL_SETTINGS_REASON),
      createConnection: async () => absent(LOCAL_SETTINGS_REASON),
      renameConnection: async () => absent(LOCAL_SETTINGS_REASON),
      deleteConnection: async () => absent(LOCAL_SETTINGS_REASON),
      catalogue: async () => {
        // The one server read worth answering: the catalogue *is* what this
        // connection sees, and the pane that asks renders exactly that.
        const read = await catalogue();
        return read.ok ? ok({ profiles: read.value }) : read;
      },
      onChange: () => () => undefined,
    },

    remote: local?.remote ?? {
      status: async () => ok({ origin: config.origin }),
      configure: async ({ origin: next }) => ok({ origin: next }),
    },

    routines: {
      list: async () => absent('Routines fire on the serving machine and are managed there.'),
      create: async () => absent('Routines fire on the serving machine and are managed there.'),
      update: async () => absent('Routines fire on the serving machine and are managed there.'),
      remove: async () => absent('Routines fire on the serving machine and are managed there.'),
      runNow: async () => absent('Routines fire on the serving machine and are managed there.'),
      onChange: () => () => undefined,
    },
  };
}
