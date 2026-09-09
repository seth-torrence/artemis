/**
 * `@rx-artemis/protocol` — the shared contract.
 *
 * Every other package in this repo imports from here and none of them import
 * from each other's internals. The package has **zero runtime dependencies**
 * and must keep it that way: it is loaded by the Electron main process, by the
 * preload script inside a locked-down context, and by the renderer in the
 * browser sandbox. Anything that cannot run in all three does not belong here.
 *
 * What lives here:
 *
 * | Module          | Contents                                                  |
 * | --------------- | --------------------------------------------------------- |
 * | `json`          | `JsonValue`, `assertNever`                                 |
 * | `ids`           | `RunId`, `SessionId`, `ProfileId`, …                       |
 * | `provider`      | `ProviderId`, `Capabilities`, `ProviderDescriptor`         |
 * | `permissions`   | `PermissionMode`, `PermissionRequest`, `PermissionDecision`|
 * | `events`        | the `AgentEvent` union                                     |
 * | `usage`         | `TokenUsage`, `UsageSnapshot`                              |
 * | `errors`        | `AgentError`, `AgentErrorCode`                             |
 * | `attachment`    | `Attachment`, `ImageAttachment`, `ImageMediaType`          |
 * | `run`           | `RunInput`, `RunHandle`, `RunStatus`                       |
 * | `session`       | `SessionSummary`                                           |
 * | `profile`       | `Profile`, `ProfileMetadata`, `configDirProblem`           |
 * | `terminal`      | `TerminalInfo`, the `TerminalEvent` union                  |
 * | `browser`       | `BrowserInfo`, `browserUrlFor`, the `BrowserEvent` union   |
 * | `planLoad`      | what live runs reserve, so the chooser is not blind to them |
 * | `openai`        | the chat-completions dialect, and the ruling on every param |
 * | `server`        | the local HTTP server: routes, catalogue shapes, state      |
 * | `remote`        | the remote bridge surface: routes, bodies, SSE framing      |
 * | `routine`       | scheduled runs: the record, schedule shapes, minute math    |
 * | `sharedConfig`  | what a shared `~/.claude` covers, and how to describe it    |
 * | `github`        | `parsePullRequestUrl`, `PullRequestSummary`                 |
 * | `agentPrompts`  | the standing-instruction library, and how it composes       |
 * | `suggestedTasks`| the follow-up work an agent offers, and where it can be run  |
 * | `secretRefs`    | addressing a secret held by a key manager, without holding it |
 * | `ipc`           | channel constants, request/response maps, `ArtemisBridge`    |
 *
 * What does *not* live here: the `ProviderAdapter` / `Run` interfaces. Those
 * are the engine's seam and live in `@rx-artemis/core/adapters`, because they
 * describe live objects with async iterables and disposal semantics — things
 * that never cross IPC. They are built out of the types in this package.
 */

export * from './json.js';
export * from './ids.js';
export * from './provider.js';
export * from './permissions.js';
export * from './usage.js';
export * from './planCapacity.js';
export * from './planLoad.js';
export * from './handoff.js';
export * from './errors.js';
export * from './events.js';
export * from './attachment.js';
export * from './run.js';
export * from './session.js';
export * from './profile.js';
export * from './toolServer.js';
export * from './terminal.js';
export * from './browser.js';
export * from './openai.js';
export * from './server.js';
export * from './remote.js';
export * from './routine.js';
export * from './sharedConfig.js';
export * from './forge.js';
export * from './github.js';
export * from './update.js';
export * from './agentPrompts.js';
export * from './suggestedTasks.js';
export * from './secretRefs.js';
export * from './ipc.js';
