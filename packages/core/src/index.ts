/**
 * `@rx-artemis/core` — the headless engine.
 *
 * Everything Artemis does that is not drawing pixels or talking to Electron
 * happens here: provider adapters, profile and environment resolution, and the
 * registry of live runs.
 *
 * ```
 * ┌── adapters ──────────────────────────────────────────────────────────┐
 * │ ProviderAdapter / Run — the seam. One implementation per provider,   │
 * │ each mapping a wildly different transport onto the same AgentEvent   │
 * │ union and publishing a capability descriptor the UI degrades against.│
 * ├── content ───────────────────────────────────────────────────────────┤
 * │ buildContentBridge  the user's skills and commands, as a plugin a    │
 * │                 run can load; marketplace plugins passed through     │
 * ├── profiles ──────────────────────────────────────────────────────────┤
 * │ ProfileStore    CRUD over account records — a label and a config dir │
 * │ resolveEnv      profile → the env bundle a run executes with         │
 * ├── secrets ───────────────────────────────────────────────────────────┤
 * │ SecretManagerProvider  OpenBao and Doppler, over an injected         │
 * │                 transport: config + credential + reference → value,  │
 * │                 and a *category* for every way that can fail         │
 * ├── sessions ──────────────────────────────────────────────────────────┤
 * │ RunRegistry     live runs by id, event fan-out, guaranteed teardown  │
 * │ SessionNamer    names a new session from its opening message         │
 * │ SessionOwners   which account each session ran under, once a store   │
 * │                 is shared and the directory no longer says           │
 * ├── server ────────────────────────────────────────────────────────────┤
 * │ Catalogue       the accounts and models this machine can route to    │
 * │ ArtemisServer   a loopback HTTP server that publishes them, so that  │
 * │                 programs outside Artemis can use its profiles too    │
 * ├── workspace ─────────────────────────────────────────────────────────┤
 * │ checkWorkingDirectory  is this cwd real, a directory, and readable?  │
 * │ describeWorkspace      what is it called — repository, or folder?    │
 * │ isTemporaryPath        will it still be there tomorrow?              │
 * └──────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Two rules hold for every module in this package:
 *
 *  1. **No `electron` import, ever** — directly or transitively. Core has to
 *     run in a plain Node process and under vitest with no Electron runtime
 *     present. Anything that genuinely needs the main process (the user-data
 *     path, say) is injected as a constructor argument.
 *  2. **No secrets, anywhere.** Core holds no credential and no handle to
 *     one: the provider's own CLI login writes its token into a profile's
 *     config directory, and core's part is to point one environment variable
 *     at that directory while stripping every variable that could
 *     authenticate the provider some other way. The only profile shape it
 *     hands upward is `ProfileMetadata`, which carries no secret because
 *     none exists.
 *
 * Types shared with the renderer — events, capabilities, IPC payloads — live
 * in `@rx-artemis/protocol` and are re-exported from nowhere: import them from
 * there directly.
 */

export * from './adapters/index.js';
export * from './content/index.js';
export * from './memorybanks/index.js';
export * from './profiles/index.js';
export * from './secrets/index.js';
export * from './sessions/index.js';
export * from './server/index.js';
export * from './workspace/index.js';
