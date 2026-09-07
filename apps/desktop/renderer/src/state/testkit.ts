/**
 * Seeding the stores from a test.
 * ============================================================================
 *
 * **Test-only. Nothing in the application imports this**, which is why it is
 * safe for it to know about both stores at once.
 *
 * The renderer's state used to be one object, and every test in the suite seeds
 * it with one flat literal: providers and profiles next to `cwd` and `run`.
 * Split view divided that object in two — the window's half in `store.ts`, the
 * column's half in `pane.ts` — and mechanically rewriting each of those literals
 * into a pair of calls would have made a dozen test files noisier without
 * making a single assertion clearer.
 *
 * So the seam is here instead: {@link seedApp} takes the flat literal the tests
 * already write and routes each key to whichever store owns it. A test that
 * cares about the division — and one does, deliberately, in `usage.test.ts` —
 * still writes to the two stores directly and asserts on both.
 *
 * The key list below is the load-bearing part, and it is checked against
 * `SessionState` by the compiler: a field added to a pane without being added
 * here would be silently routed to the window store, where it would land as a
 * stray property and the test would fail somewhere unrelated.
 */

import { focusedPane, useApp, type AppState } from './store';
import type { Capabilities } from '@rx-artemis/protocol';

import { setPaneState, type SessionState } from './pane';

/**
 * Every field a pane owns.
 *
 * Typed as a full record over `SessionState` rather than a `string[]`, so the
 * compiler rejects both a missing key and an invented one.
 */
const SESSION_KEYS: Readonly<Record<keyof SessionState, true>> = {
  providers: true,
  profiles: true,
  sessions: true,
  contextWindows: true,
  quickModelIdsByProfile: true,
  activeProviderId: true,
  activeProfileId: true,
  cwd: true,
  workspace: true,
  additionalDirectories: true,
  permissionMode: true,
  model: true,
  effort: true,
  fastMode: true,
  ultracode: true,
  forkOnResume: true,
  resumeSessionId: true,
  historyLoading: true,
  rewindToMessageId: true,
  models: true,
  modelsLoading: true,
  modelsError: true,
  commands: true,
  run: true,
  suggestion: true,
  permissionQueue: true,
  tasks: true,
  dismissedTasks: true,
  tasksRequested: true,
  filesRequested: true,
  documentsRequested: true,
  promptHistory: true,
  handoff: true,
  handoffOffer: true,
  seedHandoffTo: true,
  draft: true,
  parkedDrafts: true,
};

/**
 * The five the *window* owns despite appearing above.
 *
 * They are in `SessionState` because selectors need them alongside a pane's own
 * fields — see the mirror note in `pane.ts` — but the window is their single
 * writer, so a seed naming one of them has to go there or the next mirror pass
 * would overwrite it.
 */
const WINDOW_OWNED = new Set<keyof SessionState>([
  'providers',
  'profiles',
  'sessions',
  'contextWindows',
  'quickModelIdsByProfile',
]);

/**
 * Seed both stores from one flat object, the way `useApp.setState` used to.
 *
 * Window fields are written first so that the mirror they trigger cannot land
 * on top of a session field set in the same call.
 */
export function seedApp(patch: Partial<AppState & SessionState>): void {
  const windowPatch: Record<string, unknown> = {};
  const sessionPatch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    const owned = key in SESSION_KEYS && !WINDOW_OWNED.has(key as keyof SessionState);
    (owned ? sessionPatch : windowPatch)[key] = value;
  }

  useApp.setState(windowPatch as Partial<AppState>);
  setPaneState(focusedPane(), sessionPatch as Partial<SessionState>);
}

/** The focused column's state — what `useApp.getState()` used to return. */
export function appSession(): SessionState {
  return focusedPane().store.getState();
}

/** The focused column's transcript. There is one per column now. */
export function appTranscript(): ReturnType<typeof focusedPane>['transcript'] {
  return focusedPane().transcript;
}

/* -------------------------------------------------------------------------- */
/* Capabilities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every capability on, as one typed object.
 * ============================================================================
 *
 * Here rather than in each test file, and the reason is the same one
 * {@link SESSION_KEYS} exists for: **this file is not a test file, so the
 * compiler reads it.** `renderer/tsconfig.json` excludes `*.test.ts(x)`, which
 * means a `Capabilities` literal written inside a test is never checked against
 * the type at all.
 *
 * That is not theoretical. `tagSession` was added to `Capabilities`, every
 * adapter and the mock bridge, and the context menu's own `ALL` literal was
 * missed — silently, because nothing type-checks it. The tests then failed at
 * runtime with an undefined flag reading as "not supported", which is a long
 * way from the change that caused it.
 *
 * Declared `Capabilities` rather than inferred, so adding a flag to the type
 * breaks *this line*, once, with the name of what is missing — instead of
 * thirty test files failing on an assertion that has nothing to do with it.
 *
 * `permissionModes` carries all three: a test that needs a narrower set passes
 * one, and a test that never touches the picker should not have to think about
 * it.
 */
export const ALL_CAPABILITIES: Capabilities = {
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
  systemPromptAppend: true,
  permissionModes: ['default', 'plan', 'acceptEdits'],
  resumeSession: true,
  rewind: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
  imageInput: true,
  fileInput: true,
};

/**
 * A capability set with some flags turned off.
 *
 * The shape every test that gates on one flag actually wants: name the flag,
 * inherit the rest, and stay correct when a new one is added.
 */
export function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return { ...ALL_CAPABILITIES, ...overrides };
}
