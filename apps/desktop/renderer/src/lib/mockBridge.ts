/**
 * A fake `ArtemisBridge`, for developing the renderer without a main process.
 *
 * This exists so the UI can be exercised — streaming, permissions, capability
 * degradation, errors — before the Electron layers are wired up, and so a
 * contributor can run the renderer alone. It is installed **only** when
 * `import.meta.env.DEV` is set and `window.artemis` is absent, and when it is
 * active the status bar says so in as many words. It never masquerades as a
 * real bridge and it is dead code in a packaged build.
 *
 * It also honours the secret boundary, which is now trivial to honour: there is
 * no credential anywhere in the bridge contract, so there is nothing here that
 * could hand one back.
 */

import type {
  AgentEvent,
  AgentPromptsDocument,
  AuthStatusInfo,
  Capabilities,
  MemoryBankInfo,
  MemoryBankMemory,
  IpcResult,
  ArtemisBridge,
  PermissionDecision,
  PermissionRequest,
  PlanUsage,
  ProfileId,
  ProfileMetadata,
  ProviderDescriptor,
  ProviderModelOption,
  RunEndReason,
  RunHandle,
  RunSuggestion,
  Routine,
  RoutinesState,
  SecretConnection,
  SecretConnectionState,
  SecretProviderDescriptor,
  SecretVerifyResult,
  ServerProfile,
  ServerSignInStatus,
  ServerState,
  SharedConfigEntryState,
  UpdateCheckOutcome,
  UpdateState,
  RunsStartRequest,
  SessionSummary,
  TerminalEvent,
  TerminalInfo,
  Unsubscribe,
  WindowState,
  WorkspaceDescribeResponse,
} from '@rx-artemis/protocol';
import {
  ARTEMIS_RELEASES_URL,
  assignProfileSlugs,
  browserUrlFor,
  DEFAULT_SERVER_PORT,
  nextFireAt,
  modelRoute,
  NO_CAPABILITIES,
  SHARED_ENTRIES,
  normalizeProfileColor,
  parseAgentPromptsDocument,
  type BrowserEvent,
  type BrowserInfo,
  type BrowserState,
} from '@rx-artemis/protocol';
import { newId } from './id';

const ok = <T,>(value: T): IpcResult<T> => ({ ok: true, value });

/** The command the real bridge composes in the main process. */
const mockSignInCommand = (profileId: string): string => {
  const dir = MOCK_CONFIG_DIRS[profileId] ?? '/Users/demo/.claude';
  return `CLAUDE_CONFIG_DIR='${dir}' claude auth login`;
};

const MOCK_CONFIG_DIRS: Record<string, string> = {
  'demo-personal': '/Users/demo/.claude',
  'demo-work': '/Users/demo/Library/Application Support/Artemis/profiles/demo-work',
};

/** The `~/.claude` the fake `sharedConfig.status` reading compares against. */
const MOCK_SHARED_ROOT = '/Users/demo/.claude';

/**
 * The entries the fake reading reports as something other than linked.
 *
 * Anything absent from this map reads as `linked`, so the shape stays honest as
 * the shared list grows: a name added to `SHARED_DIRECTORIES` shows up here as
 * one more linked row rather than as a hole.
 */
const MOCK_SHARED_STATES: Record<string, SharedConfigEntryState> = {
  'session-env': 'own',
  projects: 'foreign',
  'CLAUDE.md': 'missing',
};

/**
 * Update phases `?update=` is allowed to name; anything else, including nothing,
 * is `idle`. See the `updates` namespace below for why the mock can be parked in
 * a phase but never walked through one.
 */
const MOCK_UPDATE_PHASES: readonly UpdateState['phase'][] = [
  'available',
  'working',
  'ready',
  'restarting',
  'error',
];

/**
 * Outcomes `?check=` is allowed to name, for the About pane.
 *
 * A separate parameter from `?update=` because the two are separate facts: the
 * phase is what the *state* says, the outcome is what the last *question*
 * answered, and three outcomes leave the phase at `idle`. Parking one would
 * otherwise be unreachable from a URL.
 */
const MOCK_CHECK_OUTCOMES: readonly UpdateCheckOutcome[] = [
  'offered',
  'current',
  'unreachable',
  'busy',
  'unsupported',
];

/** An event minus the envelope fields the transport stamps on. */
type EventDraft = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'runId' | 'seq' | 'ts'>
    : never
  : never;

const CLAUDE_CAPS: Capabilities = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  subagentTranscripts: true,
  renameSession: true,
  deleteSession: true,
  tagSession: true,
  permissionModes: ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'],
  resumeSession: true,
  rewind: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
  systemPromptAppend: true,
  imageInput: true,
  fileInput: true,
  taskSuggestions: true,
};

/** A deliberately weaker provider, so capability gating is visible in dev. */
const CODEX_CAPS: Capabilities = {
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
  permissionModes: ['default', 'bypassPermissions'],
  resumeSession: true,
  rewind: false,
  usageReporting: true,
  costReporting: false,
  // True, as the real adapter declares: Codex answers `account/rateLimits/read`
  // like Claude answers its own. What differs is the *shape* of the answer —
  // see `mockCodexPlanUsage`.
  planUsageReporting: true,
  // False, as the real adapter declares: Codex's only instruction lever
  // replaces the preset rather than appending to it. Kept accurate rather than
  // convenient — the Agents pane's whole scope list depends on this flag being
  // the truth about a provider, and a mock that claimed otherwise would hide
  // the one state that pane exists to explain.
  systemPromptAppend: false,
  // False *unlike* the real adapter, which supports both. This is the mock's
  // job: the composer's attach button has a disabled state with a reason
  // attached, and with both mock providers advertising the capability there
  // would be no way to see it without editing this file.
  imageInput: false,
  fileInput: false,
  // False, as the real adapter declares: nothing in Codex's app-server protocol
  // takes a host-defined tool, so there is nowhere to put `suggest_task`. This
  // is the flag that keeps chips out of a Codex conversation entirely.
  taskSuggestions: false,
};

/**
 * The catalogue `providers.models` hands back for Claude.
 *
 * Shaped after what the real CLI reports rather than after the descriptor's
 * static list, because the interesting cases are the *differences* between
 * rows: the flags and effort levels vary per model, and every gated control in
 * the redesigned UI reads them off the selected row. A uniform list would make
 * all of that render identically and hide the states worth checking.
 *
 * So the spread is chosen, not incidental:
 *
 * - every row is a real model. There is no "let the provider decide" entry any
 *   more: it named nothing, so it could not tell the user what would run, and
 *   it collected mis-clicks from the top of the list.
 * - `sonnet` supports fast mode but not ultracode, and `fable` the reverse, so
 *   the two toggles are visibly independent rather than one switch drawn twice.
 * - `haiku` declares `effortLevels: []` — no effort setting at all — which is
 *   the case that must disable the effort picker rather than shrink it.
 *
 * A module constant so the reference is stable: the store keeps this array in
 * state and derives selectors from it by identity.
 */
/**
 * What a Claude session would say it offers, asked before the session exists.
 *
 * Deliberately not the same two names the mock run reports at `session.started`:
 * one list is what a column knows *before* its first message and the other is
 * what the run itself said, and a mock where they were identical would hide
 * every wiring mistake that confuses the two.
 *
 * A module constant for the same reason {@link MOCK_LIVE_MODELS} is: the store
 * holds the array and selectors compare by identity.
 */
const MOCK_SLASH_COMMANDS: readonly string[] = [
  'clear',
  'compact',
  'context',
  'artemis-skills:cerebro',
];

const MOCK_LIVE_MODELS: readonly ProviderModelOption[] = [
  {
    id: 'fable',
    label: 'Fable 5',
    displayName: 'Claude Fable 5',
    resolvedModel: 'claude-fable-5',
    note: 'Highest reasoning ceiling. Takes every effort level, including max.',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsUltracode: true,
    adaptiveThinking: true,
  },
  {
    id: 'opus',
    label: 'Opus 5',
    displayName: 'Claude Opus 5',
    resolvedModel: 'claude-opus-5',
    note: 'The most capable general model. Slowest and most expensive per token.',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
    supportsUltracode: true,
    adaptiveThinking: true,
  },
  {
    id: 'sonnet',
    label: 'Sonnet 5',
    displayName: 'Claude Sonnet 5',
    resolvedModel: 'claude-sonnet-5',
    note: 'The balanced default: strong on code, much cheaper than Opus.',
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    supportsFastMode: true,
    adaptiveThinking: true,
  },
  {
    id: 'haiku',
    label: 'Haiku 4.5',
    displayName: 'Claude Haiku 4.5',
    resolvedModel: 'claude-haiku-4-5-20251001',
    note: 'Fastest and cheapest. Best for small, mechanical edits.',
    effortLevels: [],
  },
];

interface MockRun {
  readonly runId: string;
  cancelled: boolean;
  seq: number;
  readonly permissions: Map<string, (decision: PermissionDecision) => void>;
  readonly queue: string[];
}

const FINAL_USAGE = {
  scope: 'final',
  tokens: { inputTokens: 1840, outputTokens: 612, cacheReadInputTokens: 12_400 },
  costUsd: 0.0231,
  contextTokens: 18_930,
  contextWindow: 200_000,
} as const;

/**
 * A plan for the scripted `ExitPlanMode` park, in the shape real ones arrive in.
 *
 * Every construct the card has to render: headings at two levels, prose, a GFM
 * table, an ordered list, inline code and a fenced block. A one-paragraph
 * placeholder would look fine while proving nothing.
 */
const MOCK_PLAN = `# Replace the polling loop with a watcher

## Context

\`refreshSessions\` runs on a 2s timer whether or not anything changed, which is
most of the app's idle CPU. The session directory already emits filesystem
events; nothing is listening to them.

| Approach | Idle cost | Risk |
| --- | --- | --- |
| Keep polling | ~4% CPU | none |
| \`fs.watch\` | ~0% | misses on some network mounts |
| Watch + slow poll | ~0.2% | none |

## Steps

1. Add a watcher on the sessions directory, debounced to one frame.
2. Drop the interval to 30s as a backstop for mounts \`fs.watch\` cannot see.
3. Tear the watcher down with the profile that owns it.

\`\`\`ts
const watcher = watch(dir, { persistent: false }, () => refreshSoon());
\`\`\`

## Not doing

Reworking how sessions are read. This changes *when* the read happens, not what
it does — worth keeping the diff to one question.`;

const SIGNED_OUT: AuthStatusInfo = { loggedIn: false, authMethod: 'none' };
const SIGNED_IN: AuthStatusInfo = {
  loggedIn: true,
  authMethod: 'claude.ai',
  email: 'demo@example.com',
  orgName: 'Demo Org',
  subscriptionType: 'max',
};

/**
 * How many polls of *one profile* the mock stays signed out for.
 *
 * The real flow has the user leave the app, complete a browser login, and come
 * back; the screen learns about it only by polling. Flipping on a count rather
 * than on a method call is what reproduces that — a mock that signed in the
 * instant it was asked would make the waiting state, which is the part most
 * worth being able to look at, unreachable in dev.
 *
 * Counted per profile, because a shared counter is not merely imprecise: the
 * card list polls every profile it renders, so three cards would exhaust a
 * global budget between one render and the next and the waiting state would
 * never be visible at all. Login state belongs to a config directory, and the
 * mock has to model that or it stops standing in for anything.
 */
const MOCK_POLLS_BEFORE_SIGNED_IN = 4;
const mockAuthPolls = new Map<string, number>();
const mockSignedOut = new Set<string>(['demo-personal']);

/**
 * Accounts on the pretend Artemis server, and the one sign-in it will drive.
 *
 * The server's own accounts, not this machine's — so the pane has something to
 * list before anything is added, and the "already signed in" row is next to the
 * "signed out" one that the sign-in flow is for.
 */
function mockServerProfile(id: string, label: string): ServerProfile {
  return {
    id: id as ProfileId,
    slug: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
    provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
    available: true,
    disabled: false,
    live: false,
    capabilities: NO_CAPABILITIES,
    models: [],
  };
}

let mockRemoteAccounts: readonly ServerProfile[] = [
  { ...mockServerProfile('remote-work', 'work'), live: true },
];
let mockSignIn: ServerSignInStatus | null = null;

/**
 * One poll, one step — the shape the real flow has.
 *
 * The URL does not arrive with the first answer and the code prompt does not
 * arrive with the URL, because each is a line the CLI prints when it gets
 * round to it. A mock that handed back everything at once would make both
 * intermediate states unreachable in dev, which is where they are most easily
 * looked at.
 */
function advanceMockSignIn(current: ServerSignInStatus | null): ServerSignInStatus | null {
  if (current === null) return null;
  if (current.state === 'starting') {
    return {
      ...current,
      state: 'awaiting_browser',
      verificationUrl: 'https://claude.ai/oauth/authorize?code=true&mock=1',
    };
  }
  if (current.state === 'awaiting_browser') return { ...current, state: 'awaiting_code' };
  return current;
}

/**
 * The banks "on this machine": agents write to the real ones; here, retire
 * deletes. Two banks so the multi-bank rendering — read-only badge, default
 * marker, per-bank switches — is the state dev meets by default.
 */
let mockMasterEnabled = true;
let mockBanks: MemoryBankInfo[] = [
  {
    slug: 'team-memory',
    path: '/Users/demo/Documents/team-memory',
    remote: 'https://github.com/demo-team/team-memory.git',
    role: 'readwrite',
    enabled: true,
    isDefault: true,
    exists: true,
    source: 'cerebro@52a0a32',
    memories: 3,
    mirrored: 0,
    validationErrors: 0,
    projects: 27,
    // Held as a reference rather than as a token, so the pane's "from a key
    // manager" rendering is what dev meets by default — including the degraded
    // sentence, which is the state a real machine reaches only when its vault
    // is actually down.
    credential: { kind: 'ref' },
  },
  {
    slug: 'client-docs',
    path: '/Users/demo/Documents/client-docs',
    remote: null,
    role: 'readonly',
    enabled: false,
    isDefault: false,
    exists: true,
    source: 'cerebro@1a2b3c4',
    memories: 1,
    mirrored: 0,
    validationErrors: 0,
    projects: 4,
    credential: { kind: 'none' },
  },
];

/* -------------------------------------------------------------------------- */
/* Key managers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The configured managers "on this machine".
 *
 * Two, and deliberately one of each provider: the pane's whole reason for
 * building its forms from provider descriptors is that the two look different,
 * and a dev fixture with one of them would let that difference rot.
 */
let mockSecretConnections: SecretConnectionState[] = [
  {
    connection: {
      id: 'sec-openbao',
      label: 'Work vault',
      provider: 'openbao',
      address: 'https://vault.example.com:8200',
      authMethod: 'userpass',
      username: 'demo',
    },
    hasCredential: true,
    lastVerify: {
      at: Date.now() - 3 * 3_600_000,
      result: {
        ok: true,
        detail: 'OpenBao 2.6.2 is active. It expires 2026-09-28T09:14:03Z.',
        identity: 'userpass-demo',
        policies: ['bao-admin', 'default'],
        expiresAt: '2026-09-28T09:14:03Z',
      },
    },
  },
  {
    connection: {
      id: 'sec-doppler',
      label: 'Team Doppler',
      provider: 'doppler',
      address: 'https://api.doppler.com',
      authMethod: 'token',
    },
    hasCredential: true,
    lastVerify: {
      at: Date.now() - 26 * 3_600_000,
      result: {
        ok: true,
        detail: 'Doppler accepted this token for the Example Co workplace.',
        identity: 'artemis-desktop (Example Co)',
        policies: ['service_token'],
      },
    },
  },
];

/** The dev descriptors, which mirror what the real providers declare. */
const MOCK_SECRET_PROVIDERS: readonly SecretProviderDescriptor[] = [
  {
    id: 'openbao',
    label: 'OpenBao',
    note: 'Self-hosted secrets with policies and short-lived tokens. Also speaks to HashiCorp Vault.',
    authMethods: ['userpass', 'token'],
    configFields: [
      {
        id: 'address',
        label: 'Address',
        placeholder: 'https://vault.example.com:8200',
        required: true,
        kind: 'text',
        note: 'The API address, including the port.',
      },
      {
        id: 'username',
        label: 'Username',
        placeholder: 'your-openbao-user',
        required: true,
        kind: 'text',
        onlyForAuthMethod: 'userpass',
        note: 'Its password is spent once on minting a token — Artemis stores the token, never the password.',
      },
    ],
    refFields: [
      { id: 'mount', label: 'Mount', placeholder: 'secret', required: true, kind: 'text' },
      { id: 'path', label: 'Path', placeholder: 'team/git', required: true, kind: 'text' },
      { id: 'key', label: 'Key', placeholder: 'git_token', required: true, kind: 'text' },
    ],
  },
  {
    id: 'doppler',
    label: 'Doppler',
    note: 'Hosted secrets, organised by project and config. Authenticates with a token you mint in Doppler.',
    authMethods: ['token'],
    configFields: [
      {
        id: 'address',
        label: 'API address',
        placeholder: 'https://api.doppler.com',
        required: false,
        kind: 'text',
        note: 'Leave empty for https://api.doppler.com.',
      },
    ],
    refFields: [
      { id: 'name', label: 'Secret', placeholder: 'GIT_TOKEN', required: true, kind: 'text' },
      { id: 'project', label: 'Project', placeholder: '(from the token)', required: false, kind: 'text' },
      { id: 'config', label: 'Config', placeholder: '(from the token)', required: false, kind: 'text' },
    ],
  },
];

function mockSecretsResponse(): {
  connections: readonly SecretConnectionState[];
  providers: readonly SecretProviderDescriptor[];
} {
  return { connections: [...mockSecretConnections], providers: MOCK_SECRET_PROVIDERS };
}

/**
 * The verify outcome for a connection, chosen from its label.
 *
 * The bank mock picks its outcome out of the remote's spelling for the same
 * reason: these are states a real manager produces rarely and at bad moments,
 * and the only way to develop against all of them is to be able to ask for one
 * by name.
 */
function mockVerifyFor(connection: SecretConnection): SecretVerifyResult {
  const label = connection.label.toLowerCase();
  if (label.includes('untrusted')) {
    return {
      ok: false,
      detail:
        `The certificate at ${connection.address} was not accepted: self signed certificate in certificate chain. ` +
        'If this manager uses a private certificate authority, fetch its certificate and confirm it before trusting it.',
      problem: 'tls',
    };
  }
  if (label.includes('sealed')) {
    return {
      ok: false,
      detail: 'OpenBao is sealed. It is running, and holds nothing usable until someone unseals it.',
      problem: 'sealed',
      degraded: 'sealed',
    };
  }
  if (label.includes('expired')) {
    return {
      ok: false,
      detail: 'The stored token expired on 2026-08-01T00:00:00Z. Enter the password again to mint a new one.',
      problem: 'expired',
    };
  }
  if (label.includes('standby')) {
    return {
      ok: true,
      detail: 'This is a standby node, which OpenBao reports with 429 — that is not rate limiting, and reads work.',
      identity: 'userpass-demo',
      policies: ['bao-admin', 'default'],
      degraded: 'standby',
    };
  }
  return connection.provider === 'openbao'
    ? {
        ok: true,
        detail: 'OpenBao 2.6.2 is active. It expires 2026-09-28T09:14:03Z.',
        identity: `userpass-${connection.username ?? 'demo'}`,
        policies: ['bao-admin', 'default'],
        expiresAt: '2026-09-28T09:14:03Z',
      }
    : {
        ok: true,
        detail: 'Doppler accepted this token for the Example Co workplace.',
        identity: 'artemis-desktop (Example Co)',
        policies: ['service_token'],
      };
}

function rememberMockVerify(id: string, result: SecretVerifyResult): void {
  mockSecretConnections = mockSecretConnections.map((entry) =>
    entry.connection.id === id ? { ...entry, lastVerify: { at: Date.now(), result } } : entry,
  );
}
let mockBankMemories: MemoryBankMemory[] = [
  {
    name: 'team-memory-bank',
    type: 'reference',
    description: "What the team memory bank is, and how agents keep it current",
    body: "The team memory bank is shared by every developer on the Artemis harness — and agents, not developers, maintain it.",
    added: '2026-08-14',
    author: 'demo@example.com',
    org: null,
    project: null,
    readonly: false,
    file: 'memories/team-memory-bank.md',
  },
  {
    name: 'writing-team-memories',
    type: 'feedback',
    description: 'House style for team memories: atomic, durable, absolute dates, team-relevant, no secrets',
    body: 'A team memory is one fact per file, written so a teammate (or their agent) who lacks your context can act on it.',
    added: '2026-08-14',
    author: 'demo@example.com',
    org: 'demo-org',
    project: 'harness',
    readonly: false,
    file: 'memories/demo-org/harness/writing-team-memories.md',
  },
  // A mirror-tree memory, so dev meets the grouped, read-only rendering —
  // badge on, retire hidden — without arranging a real mirror.
  {
    name: 'artemis-agent-harness',
    type: 'reference',
    description: 'Artemis is our in-house Claude agent harness; where its profiles, projects, and memory live on disk',
    body: 'Artemis is the team’s in-house agent harness, an Electron app wrapping the Claude Agent SDK.',
    added: '2026-08-14',
    author: 'demo@example.com',
    org: 'demo-org',
    project: 'sessions',
    readonly: true,
    file: 'memory/sessions/artemis-agent-harness.md',
  },
];

/**
 * The prompt library, in memory.
 *
 * Seeded with one user prompt rather than none, so the pane's populated state
 * — a selected row, an editor with content, a scope narrowed to one profile —
 * is what a developer meets first. The empty state is one delete away; the
 * populated one would otherwise have to be typed on every reload.
 *
 * Scoped to `demo-personal` on purpose: that is the Claude profile, and it puts
 * the Codex row of the scope list in its disabled-with-a-reason state without
 * anyone having to arrange it.
 */
let mockAgentPrompts: AgentPromptsDocument = parseAgentPromptsDocument({
  version: 1,
  prompts: [
    {
      id: 'prompt-house-style',
      name: 'House style',
      markdown:
        '## House style\n\n- Run `pnpm typecheck` before claiming a change is done.\n- Prefer editing an existing module over adding a parallel one.\n- Say what you *did not* do as plainly as what you did.',
      enabled: true,
      scope: { kind: 'profiles', profileIds: ['demo-personal'] },
    },
  ],
});

/**
 * The mock's answer for what a directory is, shared by the two channels that
 * need it: naming one, and splitting a worktree off it.
 *
 * A module-level function rather than a closure inside the bridge, because the
 * second caller is a sibling entry in the same frozen object and cannot reach
 * the first.
 */
function mockWorkspace(path: string): WorkspaceDescribeResponse {
  const segments = path.split('/').filter(Boolean);
  const name = segments.at(-1) ?? path;
  const temporary = segments[0] === 'tmp' ? { temporary: true } : {};
  if (path.includes('/scratch/')) return { path, name, ...temporary };

  const linked = segments.indexOf('worktrees');
  if (linked >= 0) {
    // The worktree's root is the directory *below* `worktrees/`, so a cwd
    // deeper inside one still reports the checkout it belongs to.
    const repoRoot = `/${segments.slice(0, linked + 2).join('/')}`;
    const repoName = repoRoot.split('/').at(-1) ?? name;
    /*
     * And the project is whatever the worktree was split off from — the real
     * thing reads that out of the `gitdir:` pointer, which the mock has no file
     * to read. Everything above `worktrees/`, with a `.claude` container
     * dropped, is the layout an agent's worktree actually has
     * (`<repo>/.claude/worktrees/<branch>`) and is enough to exercise the
     * sidebar grouping a worktree under its repository.
     */
    const above = segments.slice(0, linked);
    if (above.at(-1) === '.claude') above.pop();
    const projectRoot = above.length > 0 ? `/${above.join('/')}` : repoRoot;
    return { path, name, repoRoot, repoName, projectRoot, worktree: true, ...temporary };
  }

  const depth = segments.indexOf('monorepo');
  const repoRoot = depth < 0 ? path : `/${segments.slice(0, depth + 1).join('/')}`;
  return {
    path,
    name,
    repoRoot,
    repoName: repoRoot.split('/').at(-1) ?? name,
    // Not a worktree, so the project is the repository itself.
    projectRoot: repoRoot,
    ...temporary,
  };
}

export function createMockBridge(): ArtemisBridge {
  /** Profiles a `refresh` has been run for — what fills the real cache. */
  const refreshedProfiles = new Set<string>();
  const listeners = new Set<(event: AgentEvent) => void>();
  const suggestionListeners = new Set<(suggestion: RunSuggestion) => void>();
  const runs = new Map<string, MockRun>();
  const handles = new Map<string, RunHandle>();

  let profiles: ProfileMetadata[] = [
    {
      id: 'demo-personal',
      label: 'Demo — personal',
      providerId: 'claude',
      // An existing directory the user pointed at, which is the case that
      // motivated letting `configDir` be a full path at all.
      configDir: '/Users/demo/.claude',
      // One profile with a colour and one without, because "no colour" is the
      // default state and the layout has to survive a swatch appearing on some
      // rows and not others.
      color: '#7c8cff',
    },
    {
      id: 'demo-work',
      label: 'Demo — work',
      providerId: 'claude',
      // And one Artemis suggested, so both shapes are visible in dev — only the
      // second is one Artemis will offer to delete.
      configDir: '/Users/demo/Library/Application Support/Artemis/profiles/demo-work',
    },
  ];

  function emit(run: MockRun, draft: EventDraft): void {
    const event: AgentEvent = { ...draft, runId: run.runId, seq: run.seq++, ts: Date.now() };
    for (const listener of listeners) listener(event);
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function typeOut(
    run: MockRun,
    messageId: string,
    blockIndex: number,
    text: string,
  ): Promise<void> {
    for (const chunk of text.match(/\S+\s*/g) ?? [text]) {
      if (run.cancelled) return;
      emit(run, { type: 'text.delta', messageId, blockIndex, text: chunk });
      await sleep(16);
    }
    emit(run, { type: 'text.complete', messageId, role: 'assistant', blockIndex, text });
  }

  function askPermission(run: MockRun, request: PermissionRequest): Promise<PermissionDecision> {
    emit(run, { type: 'permission.request', requestId: request.id, request });
    return new Promise<PermissionDecision>((resolve) => run.permissions.set(request.id, resolve));
  }

  function finish(run: MockRun, reason: RunEndReason): void {
    if (!runs.has(run.runId)) return;
    runs.delete(run.runId);
    emit(run, { type: 'usage', usage: FINAL_USAGE });
    emit(run, {
      type: 'run.end',
      reason,
      durationMs: Date.now() - (handles.get(run.runId)?.startedAt ?? Date.now()),
      numTurns: 2,
      usage: FINAL_USAGE,
      ...(reason === 'error'
        ? { error: { code: 'provider_unavailable' as const, message: 'Mock provider fell over.' } }
        : {}),
    });
    // The real provider predicts only after a *successful* ending, and after a
    // beat — the prediction is a model call that starts when the turn's result
    // lands. The delay is what makes the chip's arrival animation visible in
    // dev rather than being painted in the same frame as the answer.
    if (reason === 'completed') {
      const runId = run.runId as RunSuggestion['runId'];
      void sleep(900).then(() => {
        for (const listener of suggestionListeners) {
          listener({
            kind: 'run-suggestion',
            runId,
            suggestion: 'Now wire the smoke test into CI so this stays fixed',
          });
        }
      });
    }
  }

  async function script(run: MockRun, request: RunsStartRequest): Promise<void> {
    const { cwd, prompt, providerId, permissionMode, model, effort } = request.input;
    await sleep(120);
    emit(run, {
      type: 'session.started',
      sessionId: newId('sess'),
      providerId,
      cwd,
      // Echo what was asked for, so the status line's "this run reports" line
      // and the run inspector show something that tracks the pickers rather
      // than a constant that would hide a broken wiring.
      model: model === undefined ? 'mock-default' : `mock-${model}${effort ? `-${effort}` : ''}`,
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      slashCommands: ['/clear', '/compact'],
      permissionMode: permissionMode ?? 'default',
      providerVersion: '0.0.0-mock',
    });

    const first = newId('msg');
    emit(run, {
      type: 'thinking.delta',
      messageId: first,
      blockIndex: 0,
      text: `The user asked: "${prompt.slice(0, 72)}". Read the layout first, then run the suite.`,
    });
    await sleep(180);
    if (run.cancelled) return finish(run, 'interrupted');

    await typeOut(run, first, 1, 'Reading the workspace layout before changing anything.');

    const readCall = newId('call');
    emit(run, {
      type: 'tool.start',
      toolCallId: readCall,
      name: 'Read',
      input: { file_path: `${cwd}/package.json` },
      title: 'Read package.json',
    });
    await sleep(420);
    emit(run, {
      type: 'tool.end',
      toolCallId: readCall,
      name: 'Read',
      status: 'ok',
      resultText: '{\n  "name": "artemis",\n  "private": true\n}',
      durationMs: 420,
    });

    // A real file edit, so the transcript's inline diff — gutters, line
    // numbers, intra-line spans — is reachable in dev without a live provider.
    const editCall = newId('call');
    emit(run, {
      type: 'tool.start',
      toolCallId: editCall,
      name: 'Edit',
      input: {
        file_path: `${cwd}/src/adapters/claude.ts`,
        old_string:
          'export function createClaudeAdapter(options?: ClaudeAdapterOptions): ProviderAdapter {\n  const now = options?.now ?? Date.now;\n  const hostEnv = options?.hostEnv;\n\n  return {\n    id: CLAUDE_PROVIDER_ID,\n    label: "Claude",\n    capabilities: CLAUDE_CAPABILITIES,\n  };\n}',
        new_string:
          'export function createClaudeAdapter(options?: ClaudeAdapterOptions): ProviderAdapter {\n  const now = options?.now ?? Date.now;\n  const hostEnv = options?.hostEnv;\n  const diagnostic = options?.onDiagnostic;\n\n  return {\n    id: CLAUDE_PROVIDER_ID,\n    label: "Claude",\n    capabilities: CLAUDE_CAPABILITIES,\n    models: CLAUDE_MODELS,\n    effortLevels: CLAUDE_EFFORT_LEVELS,\n  };\n}',
      },
      title: 'Edit src/adapters/claude.ts',
    });
    await sleep(320);
    emit(run, {
      type: 'tool.end',
      toolCallId: editCall,
      name: 'Edit',
      status: 'ok',
      resultText: 'Applied 3 additions and 0 removals.',
      durationMs: 320,
    });

    /*
     * The other thing a provider can park on: a question.
     *
     * It rides the permission wire — that callback is the only place a provider
     * can hand control back mid-turn — so without a scripted one here the
     * question card is unreachable in dev, and the only way to see it is to run
     * a real agent and hope it asks something.
     */
    const answered = await askPermission(run, {
      id: newId('perm'),
      runId: run.runId,
      toolName: 'AskUserQuestion',
      input: {},
      toolCallId: newId('call'),
      requestedAt: Date.now(),
      question: {
        questions: [
          {
            question: 'The failing test looks stale. How should I handle it?',
            header: 'Approach',
            multiSelect: false,
            options: [
              {
                label: 'Fix the test',
                description: 'Update the assertion to match the new interrupt behaviour.',
                preview:
                  "it('emits tool.end on interrupt', () => {\n  expect(events.at(-1)).toMatchObject({ type: 'tool.end', status: 'denied' })\n})",
              },
              {
                label: 'Fix the code',
                description: 'Treat the assertion as correct and change the adapter instead.',
              },
              {
                label: 'Leave it',
                description: 'Report the failure and move on without touching either.',
              },
            ],
          },
          {
            question: 'Which checks should I run before I hand this back?',
            header: 'Checks',
            multiSelect: true,
            options: [
              { label: 'lint', description: 'ESLint over the changed files.' },
              { label: 'types', description: 'A full `tsc -b` across the workspace.' },
              { label: 'tests', description: 'The whole suite, every package.' },
            ],
          },
        ],
      },
    });
    if (run.cancelled) return finish(run, 'interrupted');

    await typeOut(
      run,
      newId('msg'),
      0,
      (answered.behavior === 'allow' ? answered.answers ?? [] : []).length > 0
        ? 'Thanks — taking that route.'
        : 'No answer, so I will use my own judgement.',
    );

    /*
     * The third thing a provider can park on: a plan awaiting sign-off.
     *
     * Scripted here for the same reason the question above is — without it the
     * plan card is unreachable in dev, and the only way to see one is to start a
     * real run in plan mode and wait for the agent to finish thinking. The
     * markdown is deliberately varied (headings, a table, a list, a fenced
     * block) because rendering *that* correctly is the entire point of the card.
     */
    const planned = await askPermission(run, {
      id: newId('perm'),
      runId: run.runId,
      toolName: 'ExitPlanMode',
      input: { plan: MOCK_PLAN, planFilePath: '/Users/demo/.claude/plans/mock-plan.md' },
      toolCallId: newId('call'),
      title: 'Artemis has a plan',
      displayName: 'Approve plan',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', scope: 'session' }],
      requestedAt: Date.now(),
      plan: { plan: MOCK_PLAN, planPath: '/Users/demo/.claude/plans/mock-plan.md' },
    });
    if (run.cancelled) return finish(run, 'interrupted');

    if (planned.behavior === 'deny') {
      await typeOut(run, newId('msg'), 0, 'Right — back to the drawing board.');
      return finish(run, planned.interrupt === true ? 'permission_denied' : 'completed');
    }
    await typeOut(run, newId('msg'), 0, 'Approved. Starting on it now.');

    const bashCall = newId('call');
    const decision = await askPermission(run, {
      id: newId('perm'),
      runId: run.runId,
      toolName: 'Bash',
      input: { command: 'pnpm -r test', description: 'Run the workspace test suite' },
      toolCallId: bashCall,
      title: 'Artemis wants to run a shell command',
      displayName: 'Run command',
      description: 'Executes `pnpm -r test` in the working directory.',
      reason: 'Bash is not on the allow-list for this project.',
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
          scope: 'session',
        },
      ],
      requestedAt: Date.now(),
    });
    if (run.cancelled) return finish(run, 'interrupted');

    if (decision.behavior === 'deny') {
      emit(run, { type: 'tool.end', toolCallId: bashCall, name: 'Bash', status: 'denied' });
      await typeOut(run, newId('msg'), 0, 'Understood — leaving the test suite alone.');
      return finish(run, decision.interrupt === true ? 'permission_denied' : 'completed');
    }

    emit(run, {
      type: 'tool.start',
      toolCallId: bashCall,
      name: 'Bash',
      input: { command: 'pnpm -r test' },
      title: 'pnpm -r test',
    });
    await sleep(700);
    emit(run, {
      type: 'tool.end',
      toolCallId: bashCall,
      name: 'Bash',
      status: 'error',
      resultText: 'FAIL  packages/core/src/adapters/claude.test.ts\n  ✗ emits tool.end on interrupt',
      error: { code: 'unknown', message: 'Command exited with status 1' },
      durationMs: 700,
    });

    await typeOut(
      run,
      newId('msg'),
      0,
      'One test fails: `tool.end` is not emitted when a run is interrupted mid-call. That is the invariant the transcript relies on to clear its spinners, so it is worth fixing first.',
    );

    while (run.queue.length > 0 && !run.cancelled) {
      const next = run.queue.shift() ?? '';
      await typeOut(run, newId('msg'), 0, `Noted mid-run: "${next}". Folding it into this turn.`);
    }

    finish(run, run.cancelled ? 'interrupted' : 'completed');
  }

  /**
   * Seed history, spread across several projects and two profiles.
   *
   * Shaped for the sidebar rather than for a flat list: multiple directories so
   * grouping and group ordering are visible, two profiles inside one directory
   * so the per-row profile marker has something to distinguish, and enough rows
   * that the filter field appears and the virtualiser actually windows.
   */
  const minutes = (n: number): number => Date.now() - n * 60_000;

  const PROJECTS: readonly (readonly [string, number])[] = [
    ['/Users/dev/code/artemis', 22],
    // A worktree of the line above, where an agent puts one. It is a directory
    // of its own and groups under `artemis` all the same, which is only visible
    // in dev if the seed contains one.
    ['/Users/dev/code/artemis/.claude/worktrees/adapter-seam', 3],
    ['/Users/dev/code/api-gateway', 9],
    ['/Users/dev/scratch/spike-rope', 3],
    ['/Users/dev/work/very/deeply/nested/monorepo/packages/renderer', 4],
  ];

  const TITLES: readonly string[] = [
    'Wire the adapter seam',
    'Profile store encryption',
    'Triage the flaky permission test',
    'Rename the capability keys',
    'Streaming perf: stop re-rendering the list',
    'Sidebar grouping by project',
    'Fix the resume-into-wrong-cwd bug',
    'Audit the IPC validators',
  ];

  /*
   * Mutable, unlike the other seed data, because rename and delete are the
   * first mock handlers that *write*. A frozen list would make both look like
   * they worked and then restore the old row on the next refresh — which is
   * precisely the bug an optimistic UI is prone to, so the mock must not be
   * the thing that hides it.
   */
  let seedSessions: readonly SessionSummary[] = PROJECTS.flatMap(([cwd, count], project) =>
    Array.from({ length: count }, (_, index): SessionSummary => {
      const age = minutes(project * 90 + index * index * 37 + index * 11 + 4);
      return {
        id: `a1c9f0e2-${String(project)}${String(index).padStart(3, '0')}-4a2b-9c33-00000000000${project}`,
        providerId: 'claude',
        // Alternate profiles inside a project, which is the case the row-level
        // marker exists for.
        profileId: index % 3 === 0 ? 'demo-work' : 'demo-personal',
        cwd,
        title: `${TITLES[index % TITLES.length] ?? 'Session'}${index > TITLES.length ? ` (${index})` : ''}`,
        ...(index % 2 === 0
          ? { firstPrompt: 'Take a look at the failing case and explain what you find.' }
          : {}),
        updatedAt: age,
        messageCount: 4 + ((index * 7) % 40),
        ...(index % 4 === 0 ? { gitBranch: index % 8 === 0 ? 'main' : `fix-${index}` } : {}),
      };
    }),
  );

  const providers: readonly ProviderDescriptor[] = [
    {
      id: 'claude',
      label: 'Claude',
      capabilities: CLAUDE_CAPS,
      signInHowTo:
        'Run this in a terminal. It opens your browser, signs in to your Claude account, and writes the credential into this profile’s config directory — nothing passes through Artemis. Artemis watches that directory and continues on its own once you are done.',
      // Same pattern again for the status line's model and thinking pickers:
      // both lists come off the descriptor, so a provider that offers neither
      // renders them disabled-with-a-reason rather than showing this one's.
      models: [
        { id: 'opus', label: 'Opus', note: 'The most capable model. Slowest, most expensive.' },
        { id: 'sonnet', label: 'Sonnet', note: 'Balanced: strong on code, much cheaper.' },
        { id: 'haiku', label: 'Haiku', note: 'Fastest and cheapest.' },
      ],
      // Every level any row in `MOCK_LIVE_MODELS` names has to exist here, or
      // the per-model narrowing has nothing to narrow *to*: a model's
      // `effortLevels` are ids into this list, and one that resolves to nothing
      // would render as a missing option rather than as a constrained picker.
      effortLevels: [
        { id: 'low', label: 'Low', note: 'Minimal thinking. Fastest, least reliable.' },
        { id: 'medium', label: 'Medium', note: 'Moderate thinking for routine work.' },
        { id: 'high', label: 'High', note: 'Deep reasoning. The default.' },
        { id: 'xhigh', label: 'Extra high', note: 'More reasoning than most work needs.' },
        { id: 'max', label: 'Max', note: 'The ceiling. Slow and expensive by design.' },
      ],
      available: true,
    },
    {
      id: 'codex',
      label: 'Codex',
      capabilities: CODEX_CAPS,
      signInHowTo:
        'Runs Codex’s own sign-in against this profile’s config directory. Your browser opens to authorise ChatGPT, and the credential is written into the profile — Artemis never sees it.',
      // Available, because it is: the adapter is registered in the shipped
      // registry. It was listed as unavailable here long after that stopped
      // being true, which made the one flow this mock is for — create a profile
      // on a *second* provider and sign it in — impossible to reach in dev.
      //
      // The capabilities above are still deliberately not a transcription of the
      // real adapter. A provider shaped differently from Claude is the point:
      // that is what the degradation rules are rendered against.
      models: [
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          note: 'Frontier model for complex coding, research, and real-world work.',
          effortLevels: ['low', 'medium', 'high', 'xhigh'],
        },
        {
          id: 'gpt-5.4-mini',
          label: 'GPT-5.4 mini',
          note: 'Faster and cheaper, for routine edits and quick questions.',
          effortLevels: ['low', 'medium', 'high'],
        },
      ],
      effortLevels: [
        { id: 'low', label: 'Low', note: 'Fast responses with lighter reasoning.' },
        { id: 'medium', label: 'Medium', note: 'Balances speed and reasoning depth.' },
        { id: 'high', label: 'High', note: 'Greater reasoning depth for complex problems.' },
        { id: 'xhigh', label: 'Extra high', note: 'Maximum reasoning depth. Slowest.' },
      ],
      available: true,
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      capabilities: NO_CAPABILITIES,
      // The unavailable row, which is a state worth being able to see in dev:
      // every picker in the app renders its own "this provider offers none"
      // case, and the profile form offers it disabled with this sentence
      // attached rather than dropping it.
      models: [],
      effortLevels: [],
      available: false,
      unavailableReason: 'Not supported in this version of Artemis yet.',
    },
  ];

  /** The same assignment the real catalogue makes, from the same helper. */
  const slugs = assignProfileSlugs(profiles);

  /**
   * The mock server's state, and the fan-out the real push channel provides.
   *
   * Declared before the bridge rather than beside the rest of the mock's
   * helpers because these are *statements*: the function declarations below the
   * `return` are hoisted and these would not be.
   */
  let serverState: ServerState = {
    phase: 'stopped',
    host: '127.0.0.1',
    port: DEFAULT_SERVER_PORT,
    autoStart: false,
    // Two, because the pane's interesting states are a directory grant and a
    // scratch one, and a mock with a single row never shows the difference.
    connections: [
      {
        id: 'conn-kronos',
        label: 'Kronos',
        workspace: { kind: 'directory', path: '/Users/demo/code/kronos' },
        token: mockServerToken(),
        createdAt: Date.now() - 86_400_000,
        lastUsedAt: Date.now() - 240_000,
      },
      {
        id: 'conn-scratch',
        label: 'Summariser',
        workspace: { kind: 'ephemeral', perSession: true },
        token: mockServerToken(),
        createdAt: Date.now() - 3_600_000,
      },
    ],
    traffic: { total: 0, rejected: 0 },
  };
  const serverListeners = new Set<(state: ServerState) => void>();

  /** One example routine, so the pane never opens empty in dev. */
  let mockRoutines: Routine[] = [
    {
      id: 'routine-morning',
      name: 'Morning triage',
      instructions: 'Read the overnight alerts, summarise anything on fire, and file the rest.',
      cwd: '/Users/demo/code/kronos',
      profileId: 'prof-1',
      providerId: 'claude',
      schedule: { kind: 'weekdays', at: '09:00' },
      paused: false,
      createdAt: Date.now() - 6 * 86_400_000,
      lastFiredAt: Date.now() - 3 * 3_600_000,
      history: [
        {
          firedAt: Date.now() - 3 * 3_600_000,
          runId: 'routine-run-1',
          sessionId: 'sess-routine-1',
          outcome: 'completed',
        },
        {
          firedAt: Date.now() - 27 * 3_600_000,
          outcome: 'skipped',
          skipReason: 'overlap',
        },
      ],
    },
  ];
  const mockRunningRoutines = new Set<string>();
  const routineListeners = new Set<(state: RoutinesState) => void>();

  const routinesState = (): RoutinesState => ({
    routines: mockRoutines.map((routine) => {
      const next = routine.paused ? undefined : nextFireAt(routine.schedule, Date.now());
      return {
        ...routine,
        ...(next === undefined ? {} : { nextFireAt: next }),
        running: mockRunningRoutines.has(routine.id),
      };
    }),
  });

  const pushRoutinesState = (): void => {
    for (const listener of routineListeners) listener(routinesState());
  };

  const pushServerState = (): void => {
    for (const listener of serverListeners) listener(serverState);
  };

  // Traffic only moves while the server is up, which is the one thing about it
  // that is honest to fake: a stopped server reporting requests would teach the
  // pane's reader something untrue about what the counter means.
  setInterval(() => {
    if (serverState.phase !== 'running') return;
    serverState = {
      ...serverState,
      traffic: {
        total: serverState.traffic.total + 1,
        rejected: serverState.traffic.rejected,
        lastAt: Date.now(),
      },
    };
    pushServerState();
  }, 9_000);

  return {
    version: '0.1.0-mock',
    platform: 'darwin',
    arch: 'arm64',

    profiles: {
      list: async () => ok({ profiles }),
      create: async ({ draft }) => {
        const profile: ProfileMetadata = {
          id: newId('prof'),
          label: draft.label,
          providerId: draft.providerId,
          configDir: draft.configDir,
          // Normalised here as the real store does, so `#ABC` typed into the
          // form comes back as `#aabbcc` in dev too — the colour input only
          // accepts the long lowercase form, and a mock that skipped this
          // would show a black swatch the real app does not.
          color: normalizeProfileColor(draft.color) ?? undefined,
          // Collapsed to absent when it is the default, as the real store does:
          // the flags are read back by `isProfileEnabled` and its neighbour,
          // which treat absence as the ordinary state.
          ...(draft.autoSelect === false ? { autoSelect: false } : {}),
          ...(draft.disabled === true ? { disabled: true } : {}),
        };
        profiles = [...profiles, profile];
        // A newly created profile is signed out, and the mock has to say so or
        // the sign-in step it leads into would be skipped in dev.
        mockSignedOut.add(profile.id);
        mockAuthPolls.set(profile.id, 0);
        MOCK_CONFIG_DIRS[profile.id] = draft.configDir;
        return ok({ profile });
      },
      update: async ({ id, patch }) => {
        const existing = profiles.find((p) => p.id === id);
        if (!existing) {
          return { ok: false, error: { code: 'invalid_request', message: `No profile ${id}` } };
        }
        const updated: ProfileMetadata = {
          ...existing,
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(patch.configDir === undefined ? {} : { configDir: patch.configDir }),
          // An empty string clears the colour — see `ProfilePatch.color`. That
          // is the one patch value here that must not be treated as "unset".
          ...(patch.color === undefined
            ? {}
            : { color: normalizeProfileColor(patch.color) ?? undefined }),
          // Both values matter, unlike the colour above: a boolean with a
          // default has no "unset" to send, so `false` here is a real answer
          // rather than an absent one. The default overwrites with `undefined`
          // rather than being dropped, because `...existing` would otherwise
          // carry an old opt-out through the patch that turned it off — and
          // absent is what the flag's readers treat as the ordinary state.
          ...(patch.autoSelect === undefined
            ? {}
            : { autoSelect: patch.autoSelect === false ? false : undefined }),
          ...(patch.disabled === undefined
            ? {}
            : { disabled: patch.disabled === true ? true : undefined }),
        };
        profiles = profiles.map((p) => (p.id === id ? updated : p));
        return ok({ profile: updated });
      },
      suggestDir: async ({ label }) => {
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return ok({
          configDir: `/Users/demo/Library/Application Support/Artemis/profiles/${slug || 'profile'}`,
        });
      },
      remove: async ({ id }) => {
        profiles = profiles.filter((p) => p.id !== id);
        return ok({ id, configDirDeleted: false });
      },
    },

    providers: {
      list: async () => ok({ providers }),
      /**
       * Answers with {@link MOCK_LIVE_MODELS} and `live: true` for Claude.
       *
       * There is no CLI behind the mock, so this is a fiction either way; the
       * question is which fiction is more useful to develop against. Returning
       * the descriptor's four-row static list with `live: false` would leave
       * every model-aware surface — the catalogue in settings, the
       * quick-access picker, the per-model fast-mode and ultracode gating —
       * with nothing to gate *on*, because none of those rows carry the flags.
       * So the mock plays the part of a provider that answered: real display
       * names, per-model effort levels, and a deliberate mix of models that do
       * and do not support each flag, which is the only way the
       * disabled-with-a-reason states become visible in a browser.
       *
       * Codex stays unregistered and still gets the empty `live: false`
       * fallback, so the "nobody confirmed this list" branch is also reachable.
       */
      models: async ({ providerId }) =>
        providerId === 'claude'
          ? ok({ models: MOCK_LIVE_MODELS, live: true })
          : ok({ models: providers.find((p) => p.id === providerId)?.models ?? [], live: false }),

      /**
       * Answers with {@link MOCK_SLASH_COMMANDS} for Claude, nothing for Codex.
       *
       * The split matters more than the contents: this is what the composer's
       * menu opens from before a run exists, so a mock that answered for every
       * provider would hide the branch where a provider has no command surface
       * and the menu is correctly shut. One prefixed name is in the list on
       * purpose — it is the shape a bridged or marketplace command arrives in,
       * and the only way the menu's segment-match ranking is visible in a
       * browser.
       */
      commands: async ({ providerId }) =>
        ok({ commands: providerId === 'claude' ? MOCK_SLASH_COMMANDS : [] }),
    },

    runs: {
      start: async (request) => {
        const runId = request.input.runId ?? newId('run');
        const run: MockRun = {
          runId,
          cancelled: false,
          seq: 0,
          permissions: new Map(),
          queue: [],
        };
        runs.set(runId, run);
        const handle: RunHandle = {
          runId,
          providerId: request.input.providerId,
          profileId: request.input.profileId,
          cwd: request.input.cwd,
          status: 'starting',
          capabilities: request.input.providerId === 'claude' ? CLAUDE_CAPS : CODEX_CAPS,
          startedAt: Date.now(),
        };
        handles.set(runId, handle);
        void script(run, request).catch(() => finish(run, 'error'));
        return ok({ run: handle });
      },
      send: async ({ runId, text }) => {
        const run = runs.get(runId);
        run?.queue.push(text);
        return ok({ runId, deliveredImmediately: run !== undefined });
      },
      interrupt: async ({ runId }) => {
        const run = runs.get(runId);
        if (run) {
          run.cancelled = true;
          for (const resolve of run.permissions.values()) {
            resolve({ behavior: 'deny', message: 'Run interrupted.' });
          }
          run.permissions.clear();
          setTimeout(() => finish(run, 'interrupted'), 60);
        }
        return ok({ runId, stillQueued: [] });
      },
      respondToPermission: async ({ runId, requestId, decision }) => {
        const run = runs.get(runId);
        if (!run) return ok({ requestId });
        run.permissions.get(requestId)?.(decision);
        run.permissions.delete(requestId);
        // A real adapter says on the stream that the request has settled, so the
        // fake does too. Nothing in the mock needs it — the caller already knows
        // what it decided — but a harness that skipped it would leave the
        // renderer's `permission.resolved` handler unreachable in dev, which is
        // precisely the kind of gap this harness exists to close.
        emit(run, {
          type: 'permission.resolved',
          requestId,
          outcome: decision.behavior === 'allow' ? 'allowed' : 'denied',
          ...(decision.behavior === 'deny' && decision.message !== undefined
            ? { note: decision.message }
            : {}),
          ...(decision.behavior === 'allow' && decision.answers !== undefined
            ? { answers: decision.answers }
            : {}),
        });
        return ok({ requestId });
      },
      dispose: async ({ runId }) => {
        const run = runs.get(runId);
        if (run) run.cancelled = true;
        runs.delete(runId);
        handles.delete(runId);
        return ok({ runId });
      },
      /*
        Accepted and forgotten, which is the honest mock.

        Stopping a task is a request, and the answer arrives later as a settled
        row on the event stream — so a mock that has no delegated work to stop
        has nothing to say beyond "asked". Fabricating the notification would
        make the pane look like it works against a provider that never ran one.
      */
      stopTask: async ({ runId, taskId }) => ok({ runId, taskId }),
      list: async () => ok({ runs: [...handles.values()] }),
      /*
       * Empty, deliberately. The mock has no process pool and so no work that
       * outlives a turn — the one thing this channel exists to report. An
       * invented set would make the preview exercise a path the real bridge
       * reaches only when a workflow is mid-flight, and "known to be working"
       * is a set callers must already handle being empty (see
       * `RunsLiveWorkResponse`).
       */
      liveWork: async () => ok({ sessionIds: [], working: [], delegated: [] }),
      /*
        Always empty, and never `truncated`.

        The mock keeps no event history — a run here is a script that emits and
        forgets — so the honest answer is "nothing retained", which is exactly
        what the reload path is contracted to cope with: it re-attaches, notes
        that it cannot replay, and renders everything from the next event on.
        Fabricating a replay would test the happy path only, and hide the branch
        that a real run past its retention window actually takes.
      */
      events: async ({ runId }) => ok({ runId, events: [], truncated: false }),
      onEvent: (listener): Unsubscribe => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onSuggestion: (listener): Unsubscribe => {
        suggestionListeners.add(listener);
        return () => {
          suggestionListeners.delete(listener);
        };
      },
    },

    sessions: {
      /*
        A short replayed transcript, so selecting a session in dev shows
        history rather than an empty pane — the exact bug this feature fixes.
      */
      /*
        `limit` is honoured, and that is not pedantry about the contract.

        It is a *message* count, and the reload path asks for exactly the
        messages that precede a live run so the run's own half-written turn is
        not drawn twice. A mock that returned the whole fixture regardless would
        make that path look correct in dev while the real one deduplicated
        nothing — the one bug the parameter exists to prevent.
      */
      messages: async ({ runId, limit }) => {
        const stored: AgentEvent[] = [
          { runId, seq: 0, ts: Date.now(), type: 'text.complete', messageId: 'h1', role: 'user', text: 'Where is auth handled?', replay: true },
          { runId, seq: 1, ts: Date.now(), type: 'tool.start', toolCallId: 'h_t1', name: 'Grep', input: { pattern: 'authenticate' } },
          { runId, seq: 2, ts: Date.now(), type: 'tool.end', toolCallId: 'h_t1', status: 'ok', result: 'src/auth/session.ts:42' },
          { runId, seq: 3, ts: Date.now(), type: 'text.complete', messageId: 'h2', role: 'assistant', text: 'Auth lives in `src/auth/session.ts`.', replay: true },
        ] as AgentEvent[];
        return ok({
          events: limit === undefined ? stored : stored.slice(0, limit),
          hasMore: limit !== undefined && limit < stored.length,
        });
      },

      /*
        A subagent's own conversation, which the parent transcript never holds.

        Grows with `offset` rather than being a fixed fixture, because the
        surface it feeds *polls*: the delegated tab follows a running agent by
        asking for whatever is past what it already has. A mock that answered
        the same four messages every time would make an agent that never
        progresses look exactly like one that does, which is the one thing this
        pane exists to tell apart.
      */
      subagentMessages: async ({ runId, agentId, offset = 0, limit }) => {
        const stored: AgentEvent[] = [
          { runId, seq: 0, ts: Date.now(), type: 'text.complete', messageId: `${agentId}_1`, role: 'assistant', text: 'Reading the files I was pointed at.', replay: true },
          { runId, seq: 1, ts: Date.now(), type: 'tool.start', toolCallId: `${agentId}_t1`, name: 'Read', input: { file_path: '/repo/src/auth/session.ts' } },
          { runId, seq: 2, ts: Date.now(), type: 'tool.end', toolCallId: `${agentId}_t1`, status: 'ok', result: 'export function authenticate() {' },
          { runId, seq: 3, ts: Date.now(), type: 'tool.start', toolCallId: `${agentId}_t2`, name: 'Grep', input: { pattern: 'authenticate\\(' } },
          { runId, seq: 4, ts: Date.now(), type: 'tool.end', toolCallId: `${agentId}_t2`, status: 'ok', result: 'src/api/login.ts:12' },
          { runId, seq: 5, ts: Date.now(), type: 'text.complete', messageId: `${agentId}_2`, role: 'assistant', text: 'Auth is entered from `src/api/login.ts:12`.', replay: true },
        ] as AgentEvent[];
        const page = stored.slice(offset, limit === undefined ? undefined : offset + limit);
        return ok({
          events: page,
          hasMore: limit !== undefined && offset + limit < stored.length,
          // One stored message per event in the mock, which is the one place
          // the two counts are allowed to agree.
          consumed: page.length,
        });
      },

      /* One profile, one project — the narrow query the palette's fallback uses. */
      list: async ({ cwd, profileId }) =>
        ok({
          sessions: seedSessions
            .filter((s) => s.profileId === profileId)
            .map((s) => ({ ...s, cwd })),
          hasMore: false,
        }),
      /*
       * The sidebar's query: everything, newest first, already carrying `cwd`
       * and `profileId` on every entry. Sorted here rather than in the renderer
       * because the real handler sorts after merging profiles, and a mock that
       * returned them unsorted would let a missing sort in the UI go unnoticed
       * in dev.
       */
      listAll: async ({ limit }) => {
        const ordered = [...seedSessions].sort((a, b) => b.updatedAt - a.updatedAt);
        const page = limit === undefined ? ordered : ordered.slice(0, limit);
        return ok({ sessions: page, hasMore: page.length < ordered.length });
      },

      /*
       * Trims and caps exactly as the engine does, and answers with what it
       * stored. A mock that echoed the request would let a UI that renders its
       * own optimistic string pass in dev and disagree with the transcript in
       * the real app.
       */
      rename: async ({ profileId, sessionId, title }) => {
        const stored = title.trim().slice(0, 200);
        seedSessions = seedSessions.map((s) =>
          s.id === sessionId && s.profileId === profileId
            ? { ...s, title: stored, titleIsCustom: true }
            : s,
        );
        return ok({ title: stored });
      },

      /*
       * Reports `deleted: false` for a session that is already gone rather
       * than failing, which is the contract the real handler keeps — and the
       * case a double click reaches.
       */
      delete: async ({ profileId, sessionId }) => {
        const before = seedSessions.length;
        seedSessions = seedSessions.filter(
          (s) => !(s.id === sessionId && s.profileId === profileId),
        );
        return ok({ deleted: seedSessions.length < before });
      },

      /*
       * Writes the tag onto the seeded row, which is what makes archiving
       * behave in the browser preview: the sidebar reads `session.tag`, so a
       * mock that swallowed the write would show a row that refused to move to
       * the archive and give no reason.
       */
      tag: async ({ profileId, sessionId, tag }) => {
        let tagged = false;
        seedSessions = seedSessions.map((s) => {
          if (s.id !== sessionId || s.profileId !== profileId) return s;
          tagged = true;
          const { tag: _dropped, ...rest } = s;
          return tag === null ? rest : { ...rest, tag };
        });
        return ok({ tagged });
      },
    },

    workspace: {
      /*
       * No dialog to open without a main process, so the mock answers with a
       * seeded project — enough to exercise the "chosen" path. Cancellation and
       * failure are reachable in the real app; faking them here on a timer
       * would make the dev bridge unpredictable.
       */
      pickDirectory: async () => ok({ path: '/Users/dev/code/api-gateway' }),

      /*
       * No filesystem to walk either, so the repository is faked from the path
       * — but all five shapes the callers have to handle are reachable in dev,
       * which a mock that always answered "this directory is the repo" would
       * not give you:
       *
       *  - `~/scratch/…`  no repository at all, so the folder name is the label.
       *  - `…/monorepo/…` a repository several levels *above* the cwd, which is
       *                   the case the whole channel exists for.
       *  - `…/worktrees/…` a linked worktree, which the header names like any
       *                   other repository, the recent-folders menu declines to
       *                   record, and the sidebar files under the project it was
       *                   split off from. Keyed off the same segment git uses.
       *  - `/tmp/…`       a temporary directory, declined for the same reason.
       *                   The real check knows this machine's `tmpdir()`, which
       *                   on macOS is under `/var/folders`; `/tmp` is the one
       *                   spelling that is recognisable on sight.
       *  - everything else — the ordinary clone, cwd at the root.
       */
      describe: async ({ path }) => ok(mockWorkspace(path)),

      /*
       * No git to run, so the mock answers with the path the real one would
       * have produced — `<repo>/.worktrees/<branch>` — which makes a suggested
       * task's "Start with worktree" reachable in dev right through to the new
       * column opening in the right directory. The one thing it cannot fake
       * usefully is failure: a mock that refused on a timer would make the
       * option unpredictable, and the real failures (no git on the PATH, a
       * repository with no commits) are reachable in the app.
       */
      createWorktree: async ({ path, branch }) => {
        const described = mockWorkspace(path);
        const root = described.projectRoot ?? described.repoRoot ?? path;
        return ok({ path: `${root}/.worktrees/${branch}`, branch });
      },
    },

    /*
     * A half-finished share, because that is the state worth being able to look
     * at in dev.
     *
     * No filesystem here, so the reading is scripted — and scripted to the one
     * case a real machine hides: `demo-personal` *is* `~/.claude` and must read
     * as the root rather than as unlinked, while `demo-work` has some entries
     * linked, one folder of its own with a backup beside it, one link into
     * somebody else's dotfiles, and a `CLAUDE.md` that is missing for the
     * blameless reason that the root has none either. Between them they exercise
     * every row the pane can draw.
     */
    sharedConfig: {
      status: async () =>
        ok({
          root: MOCK_SHARED_ROOT,
          rootMissing: ['CLAUDE.md'],
          dirs: [
            { dir: MOCK_SHARED_ROOT, state: 'root' as const, entries: [] },
            {
              dir: MOCK_CONFIG_DIRS['demo-work'] ?? '/Users/demo/work',
              state: 'checked' as const,
              entries: SHARED_ENTRIES.map((name) => ({
                name,
                state: MOCK_SHARED_STATES[name] ?? ('linked' as const),
                ...(name === 'projects'
                  ? { target: '/Users/demo/dotfiles/claude/projects' }
                  : {}),
                ...(name === 'session-env' ? { backup: true } : {}),
              })),
            },
          ],
        }),
    },

    /*
     * A bank with no repo behind it. The array below is the "clone": drafts
     * upsert into it, retire deletes from it, and the messages are worded the
     * way the real CLI words them so the receipt line is exercised honestly.
     * The no-banks state is reachable by emptying `mockBanks` while developing
     * that path, which beats a hidden toggle nobody will find.
     */
    memoryBanks: {
      status: async () =>
        ok({
          cliAvailable: true,
          masterEnabled: mockMasterEnabled,
          banks: [...mockBanks],
          profiles: [
            {
              name: 'demo-personal',
              label: 'Demo — personal',
              hook: true,
              banks: Object.fromEntries(mockBanks.map((bank) => [bank.slug, bank.enabled])),
            },
            {
              name: 'demo-work',
              label: 'Demo — work',
              hook: false,
              banks: Object.fromEntries(mockBanks.map((bank) => [bank.slug, bank.enabled])),
            },
          ],
        }),
      memories: async (request) =>
        ok({ memories: request.slug === mockBanks[0]?.slug ? [...mockBankMemories] : [] }),
      preflight: async () =>
        ok({
          // One of each state, so the requirement list's three rows are all
          // reachable in dev — the failing row is what gates the button.
          ready: false,
          checks: [
            { id: 'git', label: 'git', state: 'ok' as const, detail: 'git version 2.55.0', remedy: null },
            {
              id: 'git-identity',
              label: 'git identity',
              state: 'fail' as const,
              detail: 'user.name or user.email is unset — commits would be refused',
              remedy: 'git config --global user.name "Your Name" && git config --global user.email "you@example.com"',
            },
            {
              id: 'gh',
              label: 'GitHub CLI (optional)',
              state: 'warn' as const,
              detail: 'not found — memory changes push a branch for you to open a PR from',
              remedy: 'brew install gh',
            },
          ],
        }),
      /*
       * Every outcome the pane draws differently is reachable from the URL
       * itself, so the four inline results can be seen without a network: a
       * remote whose path says `private` asks for a token (and accepts any),
       * one that says `missing` is not found, one that says `down` is
       * unreachable, and anything else is fine.
       */
      verifyRemote: async (request) => {
        const said = request.remote.toLowerCase();
        if (said.includes('private') && request.auth === undefined) {
          return ok({
            outcome: 'auth-required' as const,
            headPresent: false,
            detail: "fatal: could not read Username for 'https://git.example.com': terminal prompts disabled",
          });
        }
        if (said.includes('missing')) {
          return ok({
            outcome: 'not-found' as const,
            headPresent: false,
            detail: 'remote: Repository not found.',
          });
        }
        if (said.includes('down')) {
          return ok({
            outcome: 'unreachable' as const,
            headPresent: false,
            detail: "fatal: unable to access 'https://git.example.com/': Could not resolve host",
          });
        }
        return ok({ outcome: 'ok' as const, headPresent: true, detail: 'HEAD is 52a0a327' });
      },
      add: async (request) => {
        mockBanks = [
          ...mockBanks,
          {
            slug: request.slug,
            path: request.path ?? `/Users/demo/Documents/${request.slug}`,
            remote: request.remote ?? null,
            role: request.role,
            enabled: true,
            isDefault: mockBanks.length === 0,
            exists: true,
            source: 'cerebro@0000000',
            memories: 0,
            mirrored: 0,
            validationErrors: 0,
            projects: 0,
          },
        ];
        mockMasterEnabled = true;
        return ok({
          message: `${request.mode === 'join' ? 'Joined' : request.mode === 'create' ? 'Created a bank' : 'Adopted the bank'} as '${request.slug}'. Wired every profile. Installed into project memory.`,
        });
      },
      sync: async () => ok({ message: 'cerebro@52a0a32: 3 memories -> 27 project(s) across 3 profile(s)' }),
      retire: async (request) => {
        mockBankMemories = mockBankMemories.filter((m) => m.name !== request.name);
        return ok({ message: `cerebro: opened PR for memory-20260814-retire-${request.name}` });
      },
      setEnabled: async (request) => {
        mockBanks = mockBanks.map((bank) =>
          bank.slug === request.slug ? { ...bank, enabled: request.enabled } : bank,
        );
        return ok({
          message: request.enabled
            ? `'${request.slug}' is on. Installed into project memory.`
            : `'${request.slug}' is off — its profile block is out, and syncs skip it.`,
        });
      },
      forget: async (request) => {
        mockBanks = mockBanks.filter((bank) => bank.slug !== request.slug);
        return ok({ message: `Unwired '${request.slug}' from every profile. Forgot '${request.slug}'.` });
      },
      setMasterEnabled: async (request) => {
        mockMasterEnabled = request.enabled;
        return ok({
          message: request.enabled
            ? 'Memory banks are on for Artemis: runs sync them at start and agents are briefed about them.'
            : 'Memory banks are off for Artemis: no run-start syncs, no prompt.',
        });
      },
    },

    /*
     * The key managers, faked so the pane's *outcomes* are reachable in dev.
     *
     * The interesting thing about this pane is not its layout — it is that
     * every row can be in one of several states a real vault produces rarely
     * and inconveniently: standby, sealed, an expired token, a certificate the
     * machine does not trust. A mock that always answered "fine" would leave
     * every one of those renderings untested until a user met it.
     *
     * So the outcome is chosen from the connection's own label, the way the
     * bank mock chooses from a remote's spelling: call it "sealed" and it is
     * sealed, "standby" and it is a standby node, "untrusted" and it fails on
     * TLS so the certificate flow opens. Anything else verifies.
     */
    secrets: {
      listConnections: async () => ok(mockSecretsResponse()),
      saveConnection: async (request) => {
        const id = request.id ?? newId('sec');
        const connection: SecretConnection = {
          id,
          label: request.label,
          provider: request.provider,
          address: request.address.length > 0 ? request.address : 'https://api.doppler.com',
          ...(request.caPem === undefined ? {} : { caPem: request.caPem }),
          authMethod: request.authMethod,
          ...(request.username === undefined ? {} : { username: request.username }),
        };
        mockSecretConnections = mockSecretConnections.some((entry) => entry.connection.id === id)
          ? mockSecretConnections.map((entry) =>
              entry.connection.id === id
                ? {
                    connection,
                    hasCredential: entry.hasCredential || request.credential !== undefined,
                    lastVerify: entry.lastVerify,
                  }
                : entry,
            )
          : [
              ...mockSecretConnections,
              { connection, hasCredential: request.credential !== undefined, lastVerify: null },
            ];
        const verify = mockVerifyFor(connection);
        rememberMockVerify(id, verify);
        return ok({ ...mockSecretsResponse(), id, verify });
      },
      deleteConnection: async (request) => {
        mockSecretConnections = mockSecretConnections.filter(
          (entry) => entry.connection.id !== request.id,
        );
        return ok(mockSecretsResponse());
      },
      verifyConnection: async (request) => {
        const found = mockSecretConnections.find((entry) => entry.connection.id === request.id);
        const verify: SecretVerifyResult =
          found === undefined
            ? { ok: false, detail: 'There is no connection with that id.', problem: 'protocol' }
            : mockVerifyFor(found.connection);
        rememberMockVerify(request.id, verify);
        return ok({ ...mockSecretsResponse(), verify });
      },
      fetchServerCert: async (request) => {
        const host = request.address.replace(/^https?:\/\//, '').split('/')[0] ?? 'vault.example.com';
        return ok({
          certificate: {
            fingerprintSha256:
              '9F:3C:1A:77:B2:E0:4D:6A:8C:5F:0E:1B:7D:4A:92:68:31:C5:AE:00:BB:12:74:D9:63:8E:2F:41:0A:5D:C7:16',
            subject: `CN=${host.split(':')[0] ?? host}`,
            issuer: 'CN=Example Internal CA, O=Example',
            san: [`DNS:${host.split(':')[0] ?? host}`, 'IP Address:100.75.234.21'],
            notAfter: new Date(Date.now() + 300 * 86_400_000).toISOString(),
            pem: '-----BEGIN CERTIFICATE-----\nMIIB…mock…\n-----END CERTIFICATE-----\n',
            selfSigned: false,
          },
        });
      },
      testRef: async (request) => {
        // The three answers the Test button has to render, chosen from the
        // reference itself: a key named `missing` lists its neighbours, a
        // mount named `kv` is denied, everything else is found.
        if (request.ref.provider === 'openbao') {
          if (request.ref.mount === 'kv') {
            return ok({
              found: false,
              problem:
                'OpenBao refused kv/… (403). It answers identically for a path this token’s policy does not allow and for one that does not exist, so this is “denied, or absent” and it will not say which.',
            });
          }
          if (request.ref.key === 'missing') {
            return ok({
              found: false,
              problem: `${request.ref.mount}/${request.ref.path} has no key named “missing”.`,
              keysAtPath: ['git_token', 'username'],
            });
          }
          return ok({ found: true, keysAtPath: ['git_token', 'username'] });
        }
        return request.ref.name === 'MISSING'
          ? ok({ found: false, problem: 'Doppler has nothing at that name. Doppler said: Could not find requested secret.' })
          : ok({ found: true });
      },
    },

    /*
     * The prompt library, in memory.
     *
     * `save` re-parses through the same protocol helper the main process uses,
     * so the mock reproduces the one behaviour the pane has to cope with: the
     * document that comes back is not necessarily the one that went in — a
     * built-in's body is dropped, a missing built-in reappears. A mock that
     * echoed the request would let a bug in that handling reach a real build.
     */
    agentPrompts: {
      // The dev mock's own bank, so the built-in previews under a real name
      // here too rather than showing the placeholder the empty case renders.
      list: async () =>
        ok({
          document: mockAgentPrompts,
          memoryBanks: mockBanks.map((bank) => ({
            slug: bank.slug,
            isDefault: bank.isDefault,
            readonly: bank.role === 'readonly',
            cli: `${bank.path}/bin/cerebro`,
          })),
        }),
      save: async (request) => {
        mockAgentPrompts = parseAgentPromptsDocument(request.document);
        return ok({ document: mockAgentPrompts });
      },
    },

    /*
     * No file to read and no custom scheme to serve it from, so the mock frames
     * a `data:` page instead of an `artemis-preview:` one. That substitution is
     * only sound *here*: this bridge runs under `vite dev` with no main process,
     * so none of the policy that makes a `data:` frame unacceptable in the real
     * app is in force. It is enough to exercise the pane's layout, its caption
     * and its empty and error states, which is what the mock is for.
     */
    /*
     * A shell that is not a shell.
     *
     * There is no process to attach to here — that is the whole premise of this
     * file — so the mock is a line editor with three built-ins. It echoes what
     * is typed (a real PTY echoes; xterm does not do it locally), handles
     * backspace and Enter, and answers `pwd`, `ls` and `echo`. Anything else
     * gets a `command not found`, which is the honest answer and also the one
     * that proves the write path reached something.
     *
     * That is enough to exercise everything the renderer owns: the tab strip,
     * the dock's ownership rules, attach and detach across a session switch,
     * fit-on-resize, and the close button. What it cannot exercise is node-pty,
     * which is precisely the part that has no renderer half.
     */
    terminal: (() => {
      const listeners = new Set<(event: TerminalEvent) => void>();
      const shells = new Map<string, { info: TerminalInfo; buffer: string; line: string }>();
      let counter = 0;

      const emit = (event: TerminalEvent): void => {
        for (const listener of [...listeners]) listener(event);
      };

      const write = (id: string, text: string): void => {
        const shell = shells.get(id);
        if (!shell) return;
        shell.buffer += text;
        emit({ type: 'data', id, data: text });
      };

      const prompt = (id: string): void => {
        const shell = shells.get(id);
        if (!shell) return;
        write(id, `\r\n[38;5;147m${shell.info.cwd}[0m [38;5;114m❯[0m `);
      };

      const run = (id: string, command: string): void => {
        const shell = shells.get(id) as { info: TerminalInfo };
        const [name, ...rest] = command.trim().split(/\s+/);
        if (name === undefined || name === '') return;
        if (name === 'pwd') write(id, `\r\n${shell.info.cwd}`);
        else if (name === 'ls') write(id, '\r\nREADME.md  package.json  src');
        else if (name === 'echo') write(id, `\r\n${rest.join(' ')}`);
        else write(id, `\r\n[38;5;209mmock:[0m ${name}: command not found`);
      };

      return {
        start: async ({ cwd }) => {
          counter += 1;
          const info: TerminalInfo = {
            id: `mock-term-${String(counter)}`,
            shell: '/bin/zsh',
            cwd,
            startedAt: Date.now(),
            exited: false,
          };
          shells.set(info.id, { info, buffer: '', line: '' });
          // After the caller has had a chance to subscribe — a real terminal's
          // first bytes arrive from a process, not from inside the call that
          // started it, and a mock that emitted synchronously would let a
          // missing subscription pass unnoticed.
          setTimeout(() => {
            write(info.id, 'Mock shell — no main process. Try pwd, ls, echo.\r\n');
            prompt(info.id);
          }, 30);
          return ok({ terminal: info });
        },

        write: async ({ id, data }) => {
          const shell = shells.get(id);
          if (!shell) return { ok: false, error: { code: 'invalid_request', message: `There is no terminal ${id}.` } };
          for (const char of data) {
            if (char === '\r' || char === '\n') {
              const command = shell.line;
              shell.line = '';
              run(id, command);
              prompt(id);
            } else if (char === '' || char === '\b') {
              if (shell.line.length === 0) continue;
              shell.line = shell.line.slice(0, -1);
              // Back up, overwrite with a space, back up again — what a real
              // terminal does, and what makes the cursor land in the right place.
              write(id, '\b \b');
            } else if (char >= ' ') {
              shell.line += char;
              write(id, char);
            }
          }
          return ok({ id });
        },

        resize: async ({ id }) => ok({ id }),

        close: async ({ id }) => {
          shells.delete(id);
          return ok({ id });
        },

        list: async () => ok({ terminals: [...shells.values()].map((shell) => shell.info) }),

        replay: async ({ id }) => ok({ id, data: shells.get(id)?.buffer ?? '', truncated: false }),

        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })(),

    preview: {
      open: async ({ path }) => {
        const name = path.split('/').at(-1) ?? path;

        // Markdown needs no main process at all — the pane renders the text
        // itself — so this half of the mock is the real behaviour, not a stand-in.
        if (/\.(md|markdown)$/i.test(name)) {
          const text =
            `# ${name}\n\nA **mock** markdown preview.\n\n` +
            '- rendered by the same pipeline as the transcript\n' +
            '- no frame, no script\n\n' +
            '```ts\nconst answer = 42;\n```\n';
          return ok({ kind: 'markdown', text, title: name, path, bytes: text.length });
        }

        if (!/\.(html?|svg)$/i.test(name)) {
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: `Artemis can preview HTML, SVG and Markdown files, and ${name} is none of those.`,
            },
          };
        }
        const body = `<!doctype html><meta charset="utf-8"><title>${name}</title>` +
          '<style>body{font:14px system-ui;background:#0b0a09;color:#e8e4de;display:grid;' +
          'place-items:center;height:100vh;margin:0}</style>' +
          `<div><strong>${name}</strong><br>Mock preview — no main process.</div>`;
        return ok({
          kind: 'frame',
          url: `data:text/html;charset=utf-8,${encodeURIComponent(body)}`,
          title: name,
          path,
          bytes: body.length,
        });
      },
    },

    /*
     * Reading a file, with the three answers the viewer has to draw.
     *
     * The mock cannot read a disk, so it synthesises text from the path — which
     * is enough, because what the pane is being exercised on is the *shape* of
     * the response: a body with line numbers, a truncation notice, and a
     * refusal. A path that looks binary and one that looks huge are recognised
     * by name so both of those states are reachable in dev without finding a
     * real file that produces them.
     */
    files: {
      /*
       * A fixed little tree, so the browser preview has something to click
       * through. `truncated: false` on purpose: a mock that claimed to be
       * capped would put a banner on screen that nothing could clear.
       */
      list: async ({ path }) => ({
        ok: true as const,
        value: {
          path,
          entries: [
            { name: 'apps', kind: 'directory' as const },
            { name: 'packages', kind: 'directory' as const },
            { name: 'README.md', kind: 'file' as const, bytes: 2_048 },
            { name: 'package.json', kind: 'file' as const, bytes: 1_190 },
          ],
          truncated: false,
        },
      }),
      read: async ({ path }) => {
        const name = path.split('/').at(-1) ?? path;

        if (/\.(png|jpe?g|gif|pdf|zip|woff2?|ico)$/i.test(name)) {
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: `${name} is a binary file, so there is nothing to show as text.`,
            },
          };
        }

        const text = [
          `// ${path}`,
          '//',
          '// Mock file contents — there is no main process to read the real one.',
          '',
          'export function answer(): number {',
          '  return 42;',
          '}',
          '',
        ].join('\n');

        const huge = /\.log$/i.test(name);
        return ok({
          path,
          title: name,
          bytes: huge ? 47 * 1024 * 1024 : text.length,
          text,
          truncated: huge,
        });
      },

      /*
       * Which paths "exist".
       *
       * There is no disk here, so the rule is by name — and the names it says no
       * to are chosen to make the *interesting* state reachable in dev. `e.g` is
       * the fragment the linking rule admits it gets wrong (a two-letter
       * extension on a Latin abbreviation), and it is the one this whole channel
       * exists to stop underlining. Anything called `missing` or `todo` stands in
       * for the other half: a file the agent has said it will write and has not.
       *
       * Everything else answers yes, which matches `read` above — a mock that
       * refused paths `read` would happily synthesise would make the dev app
       * quietly unable to open anything.
       */
      check: async ({ paths }) => {
        const absent = /(^|\/)(e\.g|i\.e|missing[^/]*|todo[^/]*)$/i;
        return ok({ reachable: paths.filter((path) => !absent.test(path)) });
      },
    },

    /*
     * Pull requests, with no GitHub behind them.
     *
     * There is no `gh` here, so the answer is derived from the number — chosen
     * so every state the popover can draw is reachable in dev without a network
     * or a login, which is the whole job of this file. The cycle is by `number %
     * 6`, and the two problem rows are in it deliberately: a signed-out `gh` and
     * a PR nobody can see are states the real app spends most of its time in on
     * a fresh machine, and a mock that only ever produced happy readings would
     * let their layouts rot unseen.
     */
    github: {
      pullRequests: async ({ refs }) =>
        ok({
          results: refs.map((ref) => {
            const key = `${ref.owner}/${ref.repo}#${String(ref.number)}`;
            if (ref.number % 6 === 4) return { key, problem: 'not-found' as const };
            if (ref.number % 6 === 5) return { key, problem: 'not-signed-in' as const };

            const state =
              ref.number % 6 === 1
                ? ('merged' as const)
                : ref.number % 6 === 2
                  ? ('draft' as const)
                  : ref.number % 6 === 3
                    ? ('closed' as const)
                    : ('open' as const);
            const checks =
              ref.number % 3 === 0
                ? ('passing' as const)
                : ref.number % 3 === 1
                  ? ('failing' as const)
                  : ('pending' as const);

            return {
              key,
              summary: {
                owner: ref.owner,
                repo: ref.repo,
                number: ref.number,
                state,
                title: 'Delegated work splits live from finished',
                author: 'seth-torrence',
                additions: 128 + ref.number * 7,
                deletions: 34 + ref.number * 3,
                changedFiles: 4 + (ref.number % 9),
                checks,
              },
            };
          }),
        }),
    },

    /*
     * A browser, with no browser behind it.
     *
     * The mock cannot make a `WebContentsView` — that is a main-process object
     * and there is no main process here — so what this fakes is the *chrome's*
     * side of the contract: an id, a state that changes when you navigate, and
     * the events that carry it. In dev the pane draws its address bar and its
     * buttons over an empty rectangle, which is exactly the part of this
     * feature that has any layout in it.
     *
     * `browserUrlFor` is the real one rather than a stand-in, so a query the
     * dev app refuses is a query the packaged app refuses too.
     */
    browser: (() => {
      const open = new Map<string, BrowserInfo>();
      const listeners = new Set<(event: BrowserEvent) => void>();
      let next = 0;

      const emit = (id: string, state: BrowserState): void => {
        const info = open.get(id);
        if (info === undefined) return;
        open.set(id, { ...info, state });
        for (const listener of listeners) listener({ type: 'state', id, state });
      };

      const settle = (id: string, url: string): void => {
        emit(id, { url, title: '', loading: true, canGoBack: false, canGoForward: false });
        // A beat, so the loading state is reachable in dev rather than a frame
        // nobody ever sees.
        setTimeout(() => {
          emit(id, {
            url,
            title: url.replace(/^https?:\/\//, '').split('/')[0] ?? url,
            loading: false,
            canGoBack: true,
            canGoForward: false,
          });
        }, 400);
      };

      return {
        open: async ({ query }) => {
          const url = query === undefined ? null : browserUrlFor(query);
          if (query !== undefined && url === null) {
            return { ok: false, error: { code: 'invalid_request', message: `“${query}” is not an address.` } };
          }
          next += 1;
          const id = `mock-browser-${String(next)}`;
          const info: BrowserInfo = {
            id,
            openedAt: Date.now(),
            state: { url: url ?? '', title: '', loading: url !== null, canGoBack: false, canGoForward: false },
          };
          open.set(id, info);
          if (url !== null) settle(id, url);
          return ok({ browser: info });
        },
        navigate: async ({ id, query }) => {
          const url = browserUrlFor(query);
          if (url === null) {
            return { ok: false, error: { code: 'invalid_request', message: `“${query}” is not an address.` } };
          }
          settle(id, url);
          return ok({ id, url });
        },
        command: async ({ id }) => ok({ id }),
        layout: async ({ id }) => ok({ id }),
        close: async ({ id }) => {
          open.delete(id);
          return ok({ id });
        },
        list: async () => ok({ browsers: [...open.values()] }),
        onEvent: (listener: (event: BrowserEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })(),

    /*
     * Plan usage, faked with the stale-while-revalidate shape the real bridge
     * has: `cached` answers instantly with a slightly stale reading, `refresh`
     * takes a beat and comes back with fresher numbers. That delay is the
     * point — it is what makes the loading state reachable in dev, and the
     * whole reason the two calls are separate channels.
     */
    /**
     * Auth starts *signed out*, because that is the state the profile screen
     * has to handle well and the one a mock that always returned "signed in"
     * would hide. It flips after a few polls, standing in for a user finishing
     * the login in their own terminal.
     */
    auth: {
      status: async ({ profileId }) => {
        if (mockSignedOut.has(profileId)) {
          const polls = (mockAuthPolls.get(profileId) ?? 0) + 1;
          mockAuthPolls.set(profileId, polls);
          if (polls > MOCK_POLLS_BEFORE_SIGNED_IN) mockSignedOut.delete(profileId);
        }
        return ok({
          status: mockSignedOut.has(profileId) ? SIGNED_OUT : SIGNED_IN,
          signInCommand: mockSignInCommand(profileId),
        });
      },
      signOut: async ({ profileId }) => {
        mockSignedOut.add(profileId);
        mockAuthPolls.set(profileId, 0);
        return ok({ status: SIGNED_OUT, signInCommand: mockSignInCommand(profileId) });
      },
    },

    /**
     * Accounts on a remote Artemis, faked as the flow a person actually walks.
     *
     * The grant is on, because a mock with it off would render an empty pane
     * and hide the whole surface in dev. The sign-in advances a state per poll
     * — URL, then a prompt for the code — and refuses the first code exactly as
     * the real CLI does, because that rejection is the branch this UI most
     * needs to have been looked at.
     */
    serverAccounts: {
      list: async () => ok({ manageProfiles: true, accounts: mockRemoteAccounts }),
      create: async ({ label, provider }) => {
        const account = {
          object: 'artemis.profile' as const,
          id: `remote-${String(mockRemoteAccounts.length + 1)}`,
          label,
          providerId: provider ?? ('claude' as const),
          configDir: `/data/profiles/${label}`,
        };
        mockRemoteAccounts = [...mockRemoteAccounts, mockServerProfile(account.id, label)];
        return ok({ account });
      },
      update: async ({ accountId, label }) => {
        mockRemoteAccounts = mockRemoteAccounts.map((account) =>
          account.id === accountId && label !== undefined ? { ...account, label } : account,
        );
        const changed = mockRemoteAccounts.find((account) => account.id === accountId);
        return changed === undefined
          ? ({ ok: false, error: { code: 'invalid_request', message: 'No such account.' } } as never)
          : ok({
              account: {
                object: 'artemis.profile' as const,
                id: changed.id,
                label: changed.label,
                providerId: changed.provider.id,
                configDir: `/data/profiles/${changed.label}`,
              },
            });
      },
      delete: async ({ accountId }) => {
        const had = mockRemoteAccounts.some((account) => account.id === accountId);
        mockRemoteAccounts = mockRemoteAccounts.filter((account) => account.id !== accountId);
        return ok({ removed: had });
      },
      signIn: async ({ accountId }) => {
        mockSignIn = {
          object: 'artemis.signin',
          profileId: accountId as ProfileId,
          state: 'starting',
          startedAt: Date.now(),
          expiresAt: Date.now() + 600_000,
        };
        return ok({ signIn: mockSignIn });
      },
      signInStatus: async () => ok({ signIn: (mockSignIn = advanceMockSignIn(mockSignIn)) }),
      submitCode: async ({ code }) => {
        if (mockSignIn === null) return ok({ signIn: null });
        mockSignIn =
          code === 'GOOD'
            ? { ...mockSignIn, state: 'done', account: { email: 'someone@example.com' } }
            : {
                ...mockSignIn,
                state: 'awaiting_code',
                codeError: 'Invalid code. Please make sure the full code was copied.',
              };
        return ok({ signIn: mockSignIn });
      },
      cancelSignIn: async () => {
        mockSignIn = mockSignIn === null ? null : { ...mockSignIn, state: 'cancelled' };
        return ok({ signIn: mockSignIn });
      },
    },

    usagePlan: {
      /*
       * Empty until that profile has actually been fetched.
       *
       * The real cache is a `Map` the main process fills in `refreshPlanUsage`
       * and nowhere else, so a profile nobody has refreshed answers `null`.
       * This mock used to answer for every profile unconditionally, which made
       * the profiles screen look complete in dev while every card except the
       * active account's was blank against real CLIs — the cards were reading a
       * cache only the status bar was filling, and only for one account.
       *
       * Modelling the miss is what makes that visible here. Same rule as the
       * sign-in poll counter above: a mock that always says yes deletes the
       * state worth looking at.
       */
      cached: async ({ profileId }) =>
        ok({
          usage: refreshedProfiles.has(profileId)
            ? planUsageFor(profileId, Date.now() - 4 * 60_000, 0)
            : null,
        }),
      refresh: async ({ profileId }) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        refreshedProfiles.add(profileId);
        return ok({ usage: planUsageFor(profileId, Date.now(), 3) });
      },

      /*
       * The main process's poller, minus the subprocesses.
       *
       * Runs far faster than the real five minutes — a dev session is not five
       * minutes long, and the point of having it here at all is that the
       * profile menu's Recommended section can be *seen*. It also pushes on a
       * short delay after subscribing rather than waiting a full interval, for
       * the same reason.
       *
       * Each profile's numbers drift by a different amount, which is what makes
       * the recommendation mean something: identical readings would make every
       * account tie and the winner would always be whichever came first in the
       * list, hiding the ranking this section exists to show.
       */
      onChange: (listener): Unsubscribe => {
        let tick = 0;
        const push = (): void => {
          tick += 1;
          for (const [index, profile] of profiles.entries()) {
            refreshedProfiles.add(profile.id);
            // Alternating sign, so the leader changes as the mock polls and the
            // section is seen updating rather than only appearing.
            const drift = index * 9 * (tick % 2 === 0 ? -1 : 1);
            listener({ profileId: profile.id, usage: planUsageFor(profile.id, Date.now(), drift) });
          }
        };
        const first = setTimeout(push, 1_500);
        const timer = setInterval(push, 20_000);
        return () => {
          clearTimeout(first);
          clearInterval(timer);
        };
      },
    },

    /*
     * A browser tab has no window to minimize, zoom or close, so the three
     * commands are no-ops that answer with the state they did not change.
     *
     * `focused` is not faked, though, and that is the same rule as the sign-in
     * poll counter above: the one field a tab *can* honestly report is the one
     * worth reporting. It is what makes the header's inactive styling reachable
     * in dev at all — hard-coding `true` would leave that branch to be seen for
     * the first time in a packaged build.
     */
    window: {
      minimize: async () => ok({ state: mockWindowState() }),
      toggleMaximize: async () => ok({ state: mockWindowState() }),
      close: async () => ok({ state: mockWindowState() }),
      state: async () => ok({ state: mockWindowState() }),
      onStateChange: (listener): Unsubscribe => {
        const push = (): void => listener(mockWindowState());
        globalThis.addEventListener('focus', push);
        globalThis.addEventListener('blur', push);
        return () => {
          globalThis.removeEventListener('focus', push);
          globalThis.removeEventListener('blur', push);
        };
      },
    },

    /**
     * The updater, idle unless the URL parks it somewhere.
     *
     * Still inert, and for the original reason: the update flow's interesting
     * transitions depend on a packaged bundle and a release feed, neither of
     * which a browser tab has, and a mock that pretended to *install* would
     * exercise a path whose real counterpart replaces the app on disk. So the
     * commands here change nothing and answer with the same state they were
     * given, exactly as before.
     *
     * What is new is a way to look at the surface. `?update=available` — or
     * `working`, `ready`, `restarting`, `error` — opens the window with the
     * phase already set, because since the notice became a card at the foot of
     * the sidebar it has a *layout* to get wrong as well as wording, and no
     * unit test catches a card that is the wrong width. Behaviour stays where it
     * was tested: see `UpdateCard.test.tsx`.
     */
    updates: {
      state: async () => ok({ state: mockUpdateState() }),
      /*
       * The one command here worth answering properly, because the About pane's
       * whole content is its answer — five outcomes, five different sentences,
       * and three of them leave the state at `idle` so `?update=` cannot reach
       * any of them. `?check=current` (or `unreachable`, `busy`, `unsupported`,
       * `offered`) picks one.
       */
      check: async () => ok({ outcome: mockCheckOutcome(), state: mockUpdateState() }),
      install: async () => ok({ state: mockUpdateState() }),
      restart: async () => ok({ state: mockUpdateState() }),
      dismiss: async () => ok({ state: mockUpdateState() }),
      setChannel: async () => ok({ state: mockUpdateState() }),
      onChange: (): Unsubscribe => () => undefined,
    },

    /**
     * The menu bar, which a browser tab does not have.
     *
     * Inert rather than faked: the real push comes from a macOS application
     * menu, and there is nothing in a tab to click. Settings are reachable in
     * dev through `⌘,` and the header's own button, so nothing is lost by
     * leaving this silent.
     */
    prefsFile: {
    // The dev mock keeps preferences in `localStorage`, which is exactly where
    // the real bridge no longer puts them — see `main/prefs.ts`. In a browser
    // there is no second process to share a file with, so the old home is the
    // right one here.
    read: () => globalThis.localStorage?.getItem('artemis.prefs.v1') ?? null,
    write: (json: string) => {
      try {
        globalThis.localStorage?.setItem('artemis.prefs.v1', json);
      } catch {
        /* A full quota is not worth an error over a preference. */
      }
    },
  },

  menu: {
      onOpenSettings: (): Unsubscribe => () => undefined,
    },

    /**
     * A server that really does change state, and really does not listen.
     *
     * A browser tab cannot bind a port, so nothing here is reachable over HTTP —
     * but every *state* the pane renders is reachable, which is what this mock
     * is for. Start, stop, rotate and reconfigure all move the same value the
     * real host would move, so the running layout, the stopped layout and the
     * token block can all be seen in dev.
     *
     * Traffic ticks up on its own once running, because "nothing has called
     * this yet" and "something is calling this" are different pieces of chrome
     * and the second one is otherwise unreachable without another program.
     */
    server: {
      status: async () => ok({ state: serverState }),
      start: async () => {
        serverState = {
          ...serverState,
          phase: 'running',
          boundPort: serverState.port,
          url: `http://127.0.0.1:${serverState.port}`,
          startedAt: Date.now(),
        };
        delete (serverState as { lastError?: unknown }).lastError;
        pushServerState();
        return ok({ state: serverState });
      },
      stop: async () => {
        const { boundPort: _boundPort, url: _url, startedAt: _startedAt, ...rest } = serverState;
        serverState = { ...rest, phase: 'stopped' };
        pushServerState();
        return ok({ state: serverState });
      },
      configure: async (request) => {
        serverState = {
          ...serverState,
          port: request.port ?? serverState.port,
          autoStart: request.autoStart ?? serverState.autoStart,
        };
        if (serverState.phase === 'running') {
          serverState = {
            ...serverState,
            boundPort: serverState.port,
            url: `http://127.0.0.1:${serverState.port}`,
          };
        }
        pushServerState();
        return ok({ state: serverState });
      },
      createConnection: async (request) => {
        serverState = {
          ...serverState,
          connections: [
            ...serverState.connections,
            {
              id: `conn-${serverState.connections.length + 1}`,
              label: request.label,
              workspace: request.workspace,
              token: mockServerToken(),
              createdAt: Date.now(),
            },
          ],
        };
        pushServerState();
        return ok({ state: serverState });
      },
      renameConnection: async (request) => {
        serverState = {
          ...serverState,
          connections: serverState.connections.map((connection) =>
            connection.id === request.id ? { ...connection, label: request.label } : connection,
          ),
        };
        pushServerState();
        return ok({ state: serverState });
      },
      deleteConnection: async (request) => {
        serverState = {
          ...serverState,
          connections: serverState.connections.filter(
            (connection) => connection.id !== request.id,
          ),
        };
        pushServerState();
        return ok({ state: serverState });
      },
      /*
       * Built from the same profiles and descriptors the rest of this mock
       * serves, through the same route composition the real catalogue uses.
       * Anything less — a hand-written fixture — would let the pane look right
       * against rows no server would ever publish.
       */
      catalogue: async () =>
        ok({
          profiles: profiles.map((profile) => {
            const descriptor = providers.find((entry) => entry.id === profile.providerId);
            const slug = slugs.get(profile.id) ?? profile.id;
            return {
              id: profile.id,
              slug,
              label: profile.label,
              provider: {
                id: profile.providerId,
                label: descriptor?.label ?? profile.providerId,
                kind: descriptor?.kind ?? ('hosted' as const),
              },
              available: descriptor?.available ?? false,
              disabled: profile.disabled === true,
              live: descriptor?.available === true,
              capabilities: descriptor?.capabilities ?? NO_CAPABILITIES,
              models: (descriptor?.models ?? []).map((model) => ({
                route: modelRoute(slug, model.id),
                id: model.id,
                label: model.label,
                ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
                note: model.note,
                profileId: profile.id,
                profileSlug: slug,
                profileLabel: profile.label,
                providerId: profile.providerId,
                thinkingLevels: (descriptor?.effortLevels ?? []).filter(
                  (level) =>
                    model.effortLevels === undefined || model.effortLevels.includes(level.id),
                ),
                adaptiveThinking: model.adaptiveThinking === true,
                fastMode: model.supportsFastMode === true,
                ultracode: model.supportsUltracode === true,
                ...(model.tier === undefined ? {} : { tier: model.tier }),
              })),
            };
          }),
        }),
      onChange: (listener): Unsubscribe => {
        serverListeners.add(listener);
        return () => serverListeners.delete(listener);
      },
    },

    /*
     * The remote-origin grant, held in memory. The mock has no CSP to widen —
     * the grant's whole effect lives in main — so this only remembers what it
     * was told, which is exactly enough to develop the settings section
     * against: configure, read back, withdraw.
     */
    remote: (() => {
      let origin: string | null = null;
      return {
        status: async () => ok({ origin }),
        configure: async ({ origin: next }: { origin: string | null }) => {
          origin = next === null ? null : next.trim() || null;
          return ok({ origin });
        },
      };
    })(),

    /*
     * Routines, held in this mock's memory: enough behaviour to develop the
     * pane against — create, edit, pause, delete, a run-now that "runs" for a
     * few seconds and settles as completed — without a scheduler behind it.
     */
    routines: {
      list: async () => ok({ state: routinesState() }),
      create: async ({ draft }) => {
        mockRoutines = [
          ...mockRoutines,
          {
            id: `routine-${mockRoutines.length + 1}`,
            name: draft.name,
            instructions: draft.instructions,
            cwd: draft.cwd,
            profileId: draft.profileId,
            providerId: draft.providerId,
            ...(draft.model === undefined ? {} : { model: draft.model }),
            schedule: draft.schedule,
            paused: draft.paused === true,
            createdAt: Date.now(),
            history: [],
          },
        ];
        pushRoutinesState();
        return ok({ state: routinesState() });
      },
      update: async ({ id, patch }) => {
        mockRoutines = mockRoutines.map((routine) =>
          routine.id === id
            ? {
                ...routine,
                ...(patch.name === undefined ? {} : { name: patch.name }),
                ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
                ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
                ...(patch.profileId === undefined ? {} : { profileId: patch.profileId }),
                ...(patch.providerId === undefined ? {} : { providerId: patch.providerId }),
                ...(patch.model === undefined
                  ? {}
                  : patch.model === ''
                    ? { model: undefined }
                    : { model: patch.model }),
                ...(patch.schedule === undefined ? {} : { schedule: patch.schedule }),
                ...(patch.paused === undefined ? {} : { paused: patch.paused }),
              }
            : routine,
        );
        pushRoutinesState();
        return ok({ state: routinesState() });
      },
      remove: async ({ id }) => {
        mockRoutines = mockRoutines.filter((routine) => routine.id !== id);
        pushRoutinesState();
        return ok({ state: routinesState() });
      },
      runNow: async ({ id }) => {
        const firedAt = Date.now();
        const runId = `routine-run-${firedAt}`;
        mockRunningRoutines.add(id);
        mockRoutines = mockRoutines.map((routine) =>
          routine.id === id
            ? {
                ...routine,
                lastFiredAt: firedAt,
                history: [
                  { firedAt, runId, outcome: 'running' as const },
                  ...routine.history,
                ].slice(0, 50),
              }
            : routine,
        );
        pushRoutinesState();
        setTimeout(() => {
          mockRunningRoutines.delete(id);
          mockRoutines = mockRoutines.map((routine) =>
            routine.id === id
              ? {
                  ...routine,
                  history: routine.history.map((row) =>
                    row.runId === runId ? { ...row, outcome: 'completed' as const } : row,
                  ),
                }
              : routine,
          );
          pushRoutinesState();
        }, 4_000);
        return ok({ state: routinesState() });
      },
      onChange: (listener): Unsubscribe => {
        routineListeners.add(listener);
        return () => routineListeners.delete(listener);
      },
    },
  };

  function mockUpdateState(): UpdateState {
    const asked =
      typeof globalThis.location === 'undefined'
        ? null
        : new URLSearchParams(globalThis.location.search).get('update');
    const phase = MOCK_UPDATE_PHASES.find((candidate) => candidate === asked);
    if (phase === undefined) {
      return { phase: 'idle', version: null, message: null, releaseUrl: null, progress: null };
    }
    return {
      phase,
      version: '0.4.0',
      message: phase === 'error' ? 'The download could not be verified.' : null,
      // The shared constant, not a literal: one place decides where the
      // releases page is, and a mock that drifts from it is a dev surface
      // rehearsing the wrong answer.
      releaseUrl: phase === 'error' ? ARTEMIS_RELEASES_URL : null,
      // Mid-download, with a total: the browser preview is where the bar's
      // determinate state is looked at, and an indeterminate one is the case
      // that needs no preview to reason about.
      progress:
        phase === 'working'
          ? { step: 'downloading', transferred: 84_000_000, total: 196_000_000 }
          : null,
    };
  }

  /**
   * Which answer a manual check gives, from `?check=`.
   *
   * Defaults to `unsupported` rather than `current`, because that is what this
   * mock's host actually is. A browser tab has no install to replace, so "up to
   * date" would be the one answer the dev surface could give that is not true
   * of anything.
   */
  function mockCheckOutcome(): UpdateCheckOutcome {
    const asked =
      typeof globalThis.location === 'undefined'
        ? null
        : new URLSearchParams(globalThis.location.search).get('check');
    return MOCK_CHECK_OUTCOMES.find((candidate) => candidate === asked) ?? 'unsupported';
  }

  /** Shaped like the real one — 32 bytes, base64url — so the pane's layout meets a real length. */
  function mockServerToken(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let token = '';
    for (let index = 0; index < 43; index += 1) {
      token += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'a';
    }
    return token;
  }

  function mockWindowState(): WindowState {
    return {
      maximized: false,
      fullScreen: false,
      focused: typeof document === 'undefined' ? true : document.hasFocus(),
    };
  }


  /**
   * Plan usage in the shape the profile's *own* provider reports it.
   *
   * Not a detail. Codex meters into two anonymous windows it calls `primary`
   * and `secondary`; Claude names five-hourly, weekly and per-model buckets.
   * Serving Claude's shape for every profile is what let a meter that silently
   * filtered on Claude's window ids look correct in dev right up until it met a
   * real Codex account and rendered nothing.
   */
  function planUsageFor(profileId: string, fetchedAt: number, drift: number): PlanUsage {
    const provider = profiles.find((p) => p.id === profileId)?.providerId;
    if (provider === 'codex') return mockCodexPlanUsage(fetchedAt, drift);

    /*
     * The two demo accounts are on *different* plans — a personal subscription
     * and a work one, which is the realistic shape of having two accounts at
     * all, and the case the profile menu's recommendation has to think about.
     *
     * `pro` against `max` specifically, because both plans publish their size
     * relative to Pro and so the ranking runs *weighted*: the account with the
     * smaller share free can win, which is the one outcome that looks like a
     * bug if the tooltip has not explained it. A pairing where either side had
     * no published ratio — a Team seat, say — would fall back to comparing
     * percentages and leave that arithmetic unseen in dev.
     */
    const reading = mockPlanUsage(fetchedAt, drift);
    return {
      ...reading,
      subscriptionType: profileId === 'demo-work' ? 'pro' : 'max',
    };
  }
}

/**
 * A plausible plan reading.
 *
 * The five-hour window is deliberately the busiest: it is the one that
 * actually stops you first on a Max plan, so it is the case the UI most needs
 * to render convincingly.
 */
function mockPlanUsage(fetchedAt: number, drift: number): PlanUsage {
  const hour = 60 * 60 * 1000;
  return {
    available: true,
    subscriptionType: 'max',
    fetchedAt,
    windows: [
      {
        id: 'five_hour',
        label: '5 hours',
        utilization: 61 + drift,
        resetsAt: fetchedAt + 2 * hour,
      },
      { id: 'seven_day', label: '7 days', utilization: 23 + drift, resetsAt: fetchedAt + 71 * hour },
      {
        id: 'seven_day_opus',
        label: '7 days · Opus',
        utilization: 44 + drift,
        resetsAt: fetchedAt + 71 * hour,
      },
      /*
        A per-model bucket, in the shape `expandModelScoped` produces. The
        provider sends these as an array under one `model_scoped` key rather
        than as sibling windows, and reading that array as if it were a single
        window is what used to render one row labelled "Model" reporting
        nothing. Keeping a realistic one here means the UI is developed against
        the case that was broken.
      */
      {
        id: 'model_scoped:Fable',
        label: '7 days · Fable',
        utilization: 78 + drift,
        resetsAt: fetchedAt + 71 * hour,
      },
    ],
  };
}

/**
 * The same question answered by a provider with its own vocabulary.
 *
 * Transcribed from a live `account/rateLimits/read`: one window, named after
 * nothing in {@link PlanUsageWindowId}'s documented list, with the duration
 * carried as a label rather than as an id. Everything downstream has to cope
 * with that from data rather than from a table of names it recognises.
 */
function mockCodexPlanUsage(fetchedAt: number, drift: number): PlanUsage {
  return {
    available: true,
    subscriptionType: 'team',
    fetchedAt,
    windows: [
      {
        id: 'primary',
        label: '7 days',
        utilization: 12 + drift,
        resetsAt: fetchedAt + 71 * 60 * 60 * 1000,
      },
    ],
  };
}
