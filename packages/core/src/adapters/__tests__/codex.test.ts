/**
 * Tests for the Codex adapter's decision-making.
 *
 * Most of this is a pure function or a rejection that happens before a
 * process is spawned, so none of it touches the `codex` binary. The live
 * transport is covered by `jsonrpc.test.ts` on one side and `codexMapper.test.ts`
 * on the other; what is left in between — permission mapping, input validation,
 * response parsing, approval translation — is what this file pins down.
 *
 * The one exception is the permission lifecycle at the bottom, which drives a
 * real `CodexRun` against a *scripted* fake app server — a few lines of Node
 * standing in for `codex app-server` — because `permission.resolved` is
 * emitted from the run's answer/interrupt/dispose paths and nothing short of
 * the run exercises them. Still no real `codex` binary.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  AgentEvent,
  JsonValue,
  PermissionMode,
  ProfileId,
  RunId,
  SessionId,
} from '@rx-artemis/protocol';

import {
  CODEX_CAPABILITIES,
  CODEX_CREDENTIALS,
  CODEX_CREDENTIAL_ENVS,
  CODEX_HOME_ENV,
  createCodexAdapter,
  isMissingRollout,
  parseCodexAuthStatus,
  parseModelList,
  parseRateLimitWindows,
  parseThreadList,
  toApprovalResponse,
  toCodexPermissions,
  validateCodexRunInput,
} from '../codex.js';
import { CODEX_SERVER_REQUEST } from '../codexProtocol.js';
import { DISPOSED_DENY_MESSAGE } from '../mapper.js';
import { isAdapterError } from '../types.js';
import type { ProbeResult, ResolvedRunInput, Run } from '../types.js';

const PROFILE = 'p-1' as ProfileId;

function runInput(overrides?: Partial<ResolvedRunInput>): ResolvedRunInput {
  return {
    providerId: 'codex',
    profileId: PROFILE,
    cwd: '/work/repo',
    prompt: 'hello',
    runId: 'run-1' as RunId,
    env: { [CODEX_HOME_ENV]: '/profiles/work' },
    ...overrides,
  };
}

describe('capabilities', () => {
  it('advertises only permission modes Codex can honour exactly', () => {
    // `dontAsk` means "never prompt, deny instead". Codex's `never` proceeds
    // instead of denying, so offering it would be silently more permissive than
    // the user asked for. `auto` has no equivalent at all.
    expect(CODEX_CAPABILITIES.permissionModes).toEqual([
      'plan',
      'default',
      'acceptEdits',
      'bypassPermissions',
    ]);
  });

  it('claims streaming, steering and plan usage, but not cost', () => {
    expect(CODEX_CAPABILITIES).toMatchObject({
      interactivePermissions: true,
      partialMessages: true,
      midRunSteering: true,
      forkSession: true,
      resumeSession: true,
      listSessions: true,
      usageReporting: true,
      planUsageReporting: true,
      costReporting: false,
      subagents: false,
      imageInput: true,
      fileInput: true,
    });
  });

  it('claims deletion and renaming', () => {
    // `thread/delete` removes the rollout file outright, which is the promise
    // the capability makes — `thread/archive` would only hide it. Renaming
    // writes the same `name` field Codex's own UI does, via `thread/name/set`.
    expect(CODEX_CAPABILITIES.deleteSession).toBe(true);
    expect(CODEX_CAPABILITIES.renameSession).toBe(true);
  });
});

describe('isMissingRollout', () => {
  it('recognises the wording Codex uses for an unknown thread id', () => {
    // Verbatim from codex-cli 0.147: a JSON-RPC -32600 whose message names the
    // missing rollout. The code is shared with malformed requests, so only the
    // message distinguishes "already gone" from "broken".
    expect(
      isMissingRollout(
        new Error('thread/delete failed: no rollout found for thread id 0000 (code -32600)'),
      ),
    ).toBe(true);
  });

  it('does not mistake other failures for absence', () => {
    expect(isMissingRollout(new Error('The Codex app server did not answer.'))).toBe(false);
    expect(isMissingRollout(new Error('thread/delete failed: permission denied'))).toBe(false);
  });
});

describe('credentials', () => {
  it('scopes a profile with CODEX_HOME', () => {
    expect(CODEX_CREDENTIALS.configDirVar).toBe('CODEX_HOME');
  });

  it('strips every variable that could authenticate around the profile', () => {
    // Each of these outranks CODEX_HOME. An OPENAI_API_KEY in the user's shell
    // would bill metered usage against the subscription the profile just signed
    // into.
    expect(CODEX_CREDENTIAL_ENVS).toContain('OPENAI_API_KEY');
    expect(CODEX_CREDENTIAL_ENVS).toContain('OPENAI_BASE_URL');
    expect(CODEX_CREDENTIAL_ENVS).toContain('CODEX_HOME');
  });

  it('names the real login argv', () => {
    expect(CODEX_CREDENTIALS.signIn.executable).toBe('codex');
    expect(CODEX_CREDENTIALS.signIn.loginArgs).toEqual(['login']);
    expect(CODEX_CREDENTIALS.signIn.statusArgs).toEqual(['login', 'status']);
    expect(CODEX_CREDENTIALS.signIn.logoutArgs).toEqual(['logout']);
  });

  it('supplies its own status parser, because Codex prints prose', () => {
    // Without this, the shared polling path would run Claude's JSON reader over
    // "Logged in using ChatGPT" and report a signed-in profile as signed out.
    expect(CODEX_CREDENTIALS.signIn.parseStatus).toBe(parseCodexAuthStatus);
  });
});

describe('parseCodexAuthStatus', () => {
  const probe = (stdout: string, exitCode = 0, stderr = ''): ProbeResult => ({
    stdout,
    stderr,
    exitCode,
  });

  it('reads the signed-in line from stderr, where Codex actually writes it', () => {
    // The bug this pins down: `codex login status` writes to stderr and leaves
    // stdout empty. `codex login status 2>&1` hides that completely, which is
    // how the first version of this parser shipped reading only stdout and
    // reported a signed-in account as an error.
    expect(parseCodexAuthStatus(probe('', 0, 'Logged in using ChatGPT\n'))).toEqual({
      loggedIn: true,
      authMethod: 'chatgpt',
    });
  });

  it('reads it from stdout too, in case that ever changes', () => {
    expect(parseCodexAuthStatus(probe('Logged in using ChatGPT\n'))).toEqual({
      loggedIn: true,
      authMethod: 'chatgpt',
    });
  });

  it('reads the signed-out line, which exits non-zero', () => {
    // Exit 1 is the *normal* signed-out case, so the exit code cannot be the
    // signal — the text is.
    expect(parseCodexAuthStatus(probe('', 1, 'Not logged in\n'))).toEqual({
      loggedIn: false,
      authMethod: 'none',
    });
  });

  it('does not mistake "Not logged in" for a match on "logged in"', () => {
    // The substring is right there; order of the checks is what saves it.
    expect(parseCodexAuthStatus(probe('Not logged in', 1)).loggedIn).toBe(false);
  });

  it('normalises the auth method to the app server’s vocabulary', () => {
    // `getAuthStatus` over the app server says `chatgpt` / `apikey`. The two
    // paths describe the same account, so they must not disagree about it.
    expect(parseCodexAuthStatus(probe('Logged in using ChatGPT')).authMethod).toBe('chatgpt');
    expect(parseCodexAuthStatus(probe('Logged in using an API key')).authMethod).toBe('apikey');
  });

  it('still reports signed in when the method is unfamiliar', () => {
    const status = parseCodexAuthStatus(probe('Logged in using Enterprise SSO'));
    expect(status.loggedIn).toBe(true);
    expect(status.authMethod).toBe('enterprise sso');
  });

  it('handles a bare "Logged in" with no method', () => {
    expect(parseCodexAuthStatus(probe('Logged in'))).toEqual({
      loggedIn: true,
      authMethod: 'unknown',
    });
  });

  it('names a missing config directory rather than claiming signed out', () => {
    const status = parseCodexAuthStatus(
      probe('', 1, 'Error loading configuration: CODEX_HOME points to "/nope", but that path does not exist'),
    );

    expect(status.loggedIn).toBe(false);
    expect(status.error).toMatch(/directory does not exist/);
  });

  it('reports anything unrecognised as an error, not as signed out', () => {
    // A wrong "signed out" sends the user round a login loop they have already
    // completed; an error at least says what it saw.
    const status = parseCodexAuthStatus(probe('zsh: command not found: codex', null));
    expect(status.loggedIn).toBe(false);
    expect(status.error).toMatch(/command not found/);
  });

  it('reports empty output as an error', () => {
    expect(parseCodexAuthStatus(probe('', 0)).error).toBeTruthy();
  });

  it('never throws, whatever it is handed', () => {
    for (const stdout of ['', '\n\n', '{}', '💥', 'Logged in using '.repeat(500)]) {
      expect(() => parseCodexAuthStatus(probe(stdout))).not.toThrow();
    }
  });
});

describe('toCodexPermissions', () => {
  const options = { cwd: '/work/repo' };

  it('makes plan mode genuinely read-only', () => {
    // `never` alone would let the agent mutate without asking; the sandbox is
    // what actually enforces "research and propose only".
    expect(toCodexPermissions('plan', options)).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });

  it('maps default onto untrusted plus a writable workspace', () => {
    expect(toCodexPermissions('default', options)).toEqual({
      approvalPolicy: 'untrusted',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/work/repo'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it('lets acceptEdits write without prompting but still gate escalations', () => {
    const result = toCodexPermissions('acceptEdits', options);
    expect(result.approvalPolicy).toBe('on-request');
    expect(result.sandboxPolicy).toMatchObject({ type: 'workspaceWrite' });
  });

  it('maps bypassPermissions onto full access', () => {
    expect(toCodexPermissions('bypassPermissions', options)).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('treats an absent mode as default', () => {
    expect(toCodexPermissions(undefined, options)).toEqual(toCodexPermissions('default', options));
  });

  it('adds additional directories to the writable roots', () => {
    const result = toCodexPermissions('default', {
      cwd: '/work/repo',
      additionalDirectories: ['/work/shared', '/tmp/scratch'],
    });

    expect(result.sandboxPolicy).toMatchObject({
      writableRoots: ['/work/repo', '/work/shared', '/tmp/scratch'],
    });
  });

  it('never returns a sandbox that is more permissive than the mode asked for', () => {
    // A regression guard on the whole table: only the one mode that is
    // documented as dangerous may produce full access.
    for (const mode of ['plan', 'default', 'acceptEdits'] as PermissionMode[]) {
      expect(toCodexPermissions(mode, options).sandboxPolicy.type).not.toBe('dangerFullAccess');
    }
  });
});

describe('validateCodexRunInput', () => {
  /**
   * Called directly rather than through `createRun`, which spawns a process as
   * soon as validation passes. Every check below is supposed to fire *ahead* of
   * that, and testing it in isolation is the only way to prove it does.
   */
  function expectRejection(input: ResolvedRunInput, match: RegExp): void {
    let thrown: unknown;
    try {
      validateCodexRunInput(input);
    } catch (error) {
      thrown = error;
    }
    expect(isAdapterError(thrown)).toBe(true);
    expect((thrown as Error).message).toMatch(match);
  }

  it('rejects a relative cwd', () => {
    expectRejection(runInput({ cwd: 'relative/path' }), /absolute path/);
  });

  it('rejects a permission mode it cannot honour, rather than downgrading it', () => {
    // The seam requires rejection here: silently downgrading a permission mode
    // is how you end up more permissive than the user asked for.
    expectRejection(runInput({ permissionMode: 'dontAsk' }), /does not support/);
    expectRejection(runInput({ permissionMode: 'auto' }), /does not support/);
  });

  it('accepts every mode it advertises', () => {
    for (const permissionMode of CODEX_CAPABILITIES.permissionModes) {
      expect(() => {
        validateCodexRunInput(runInput({ permissionMode }));
      }).not.toThrow();
    }
  });

  it('rejects an effort level it does not offer', () => {
    expectRejection(runInput({ effort: 'max' }), /effort level/);
  });

  it('accepts every effort level it advertises', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      expect(() => {
        validateCodexRunInput(runInput({ effort }));
      }).not.toThrow();
    }
  });

  it('accepts a Windows-style absolute path', () => {
    // The check must not depend on which platform the test runner is on, or a
    // Windows user's runs would be rejected by a macOS-built binary.
    expect(() => {
      validateCodexRunInput(runInput({ cwd: 'C:\\Users\\me\\repo' }));
    }).not.toThrow();
    expect(() => {
      validateCodexRunInput(runInput({ cwd: '\\\\server\\share' }));
    }).not.toThrow();
  });

  it('is exposed on the adapter as the first thing createRun does', async () => {
    // Belt and braces: the rejection must survive the trip through the adapter,
    // not just exist as a helper nobody calls.
    await expect(
      createCodexAdapter().createRun(runInput({ cwd: 'relative/path' })),
    ).rejects.toThrow(/absolute path/);
  });
});

describe('parseModelList', () => {
  const response = {
    data: [
      {
        id: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 mini',
        description: 'Faster and cheaper.',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Frontier model.',
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' },
        ],
      },
      { id: 'internal-preview', displayName: 'Internal', hidden: true },
    ],
  } as unknown as JsonValue;

  it('puts the provider’s default first', () => {
    // `ProviderDescriptor.models` documents the first entry as what a run gets
    // when `model` is omitted, so this ordering is a contract.
    expect(parseModelList(response).map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
  });

  it('drops hidden models', () => {
    expect(parseModelList(response).map((m) => m.id)).not.toContain('internal-preview');
  });

  it('carries the display name, note and effort levels', () => {
    const [first] = parseModelList(response);
    expect(first).toMatchObject({
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      displayName: 'GPT-5.5',
      note: 'Frontier model.',
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
    });
  });

  it('ignores effort levels Artemis does not publish', () => {
    const [model] = parseModelList({
      data: [{ id: 'm', supportedReasoningEfforts: [{ reasoningEffort: 'ludicrous' }] }],
    } as unknown as JsonValue);

    expect(model).not.toHaveProperty('effortLevels');
  });

  it('returns nothing for a malformed response instead of throwing', () => {
    for (const value of [null, {}, { data: 'nope' }, [1, 2]] as unknown as JsonValue[]) {
      expect(parseModelList(value)).toEqual([]);
    }
  });
});

describe('parseThreadList', () => {
  const response = {
    data: [
      {
        id: 'th-1',
        cwd: '/work/repo',
        preview: 'fix the build',
        createdAt: 1782631656,
        updatedAt: 1782631679,
      },
      {
        id: 'th-2',
        cwd: '/other',
        name: 'Release prep',
        updatedAt: 1782631700,
        gitInfo: {
          sha: '87f4da6be0f4af42edca3c95621326b896473e56',
          branch: 'main',
          originUrl: 'https://github.com/Rx-Ventures/artemis.git',
        },
      },
      { id: 'th-3', preview: 'no cwd anywhere' },
    ],
  } as unknown as JsonValue;

  it('converts Unix seconds to milliseconds', () => {
    // Codex timestamps in seconds; every Artemis timestamp is milliseconds.
    const [first] = parseThreadList(response, PROFILE, undefined);
    expect(first?.updatedAt).toBe(1782631679 * 1000);
    expect(first?.createdAt).toBe(1782631656 * 1000);
  });

  it('prefers a user-assigned name over the preview, and marks it custom', () => {
    const sessions = parseThreadList(response, PROFILE, undefined);
    expect(sessions.find((s) => s.id === 'th-2')).toMatchObject({
      title: 'Release prep',
      titleIsCustom: true,
    });
    expect(sessions.find((s) => s.id === 'th-1')).toMatchObject({
      title: 'fix the build',
      firstPrompt: 'fix the build',
    });
    expect(sessions.find((s) => s.id === 'th-1')).not.toHaveProperty('titleIsCustom');
  });

  it('reads the branch Codex reports, so a row says where it came from', () => {
    /*
     * `thread/list` carries `gitInfo` — verified live against 0.147 — and the
     * sidebar's second line reads `gitBranch` off the summary. Not reading it
     * did not make the line degrade gracefully: it made every Codex row claim,
     * silently and only by omission, to have no branch, beside Claude rows that
     * all had one.
     */
    const sessions = parseThreadList(response, PROFILE, undefined);
    expect(sessions.find((s) => s.id === 'th-2')?.gitBranch).toBe('main');
    // Absent, not empty: a thread outside a repository has no branch to state.
    expect(sessions.find((s) => s.id === 'th-1')).not.toHaveProperty('gitBranch');
  });

  it('drops a thread with no recoverable cwd rather than guessing', () => {
    // A session that cannot be grouped or resumed into a known directory is
    // worse than absent.
    expect(parseThreadList(response, PROFILE, undefined).map((s) => s.id)).toEqual(['th-1', 'th-2']);
  });

  it('falls back to the queried cwd when the thread omits one', () => {
    expect(parseThreadList(response, PROFILE, '/fallback').find((s) => s.id === 'th-3')).toMatchObject(
      { cwd: '/fallback' },
    );
  });

  it('stamps every summary with the profile it was read for', () => {
    expect(parseThreadList(response, PROFILE, '/x').every((s) => s.profileId === PROFILE)).toBe(true);
    expect(parseThreadList(response, PROFILE, '/x').every((s) => s.providerId === 'codex')).toBe(true);
  });

  it('returns nothing for a malformed response', () => {
    expect(parseThreadList({} as JsonValue, PROFILE, '/x')).toEqual([]);
  });
});

describe('parseRateLimitWindows', () => {
  it('reads the windows a real free-plan account reported', () => {
    const windows = parseRateLimitWindows({
      primary: { usedPercent: 12, windowDurationMins: 43200, resetsAt: 1789003989 },
      planType: 'free',
    });

    expect(windows).toEqual([
      { id: 'primary', label: '30 days', utilization: 12, resetsAt: 1789003989 * 1000 },
    ]);
  });

  it('labels windows by their duration', () => {
    const label = (windowDurationMins: number): string =>
      parseRateLimitWindows({ primary: { windowDurationMins } })[0]?.label ?? '';

    expect(label(300)).toBe('5 hours');
    expect(label(60)).toBe('1 hour');
    expect(label(1440)).toBe('24 hours');
    expect(label(10080)).toBe('7 days');
    expect(label(43200)).toBe('30 days');
    expect(label(90)).toBe('90 minutes');
  });

  it('reports a missing utilization as null rather than zero', () => {
    // Zero means "none used"; null means "not reported". Conflating them would
    // show a full-looking gauge as empty.
    expect(parseRateLimitWindows({ primary: { windowDurationMins: 60 } })[0]?.utilization).toBeNull();
  });

  it('reads both windows when the plan has two, under the ids every plan shares', () => {
    const windows = parseRateLimitWindows({
      primary: { usedPercent: 10, windowDurationMins: 300 },
      secondary: { usedPercent: 40, windowDurationMins: 10080 },
    });

    // A five-hour window is the 5-hour limit and a week-long one the weekly,
    // so a readout draws them beside Claude's under the same names.
    expect(windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
  });

  it('keeps its own ids for a duration no other plan meters', () => {
    const windows = parseRateLimitWindows({
      primary: { usedPercent: 10, windowDurationMins: 1440 },
      secondary: { usedPercent: 40, windowDurationMins: 43200 },
    });

    expect(windows.map((w) => w.id)).toEqual(['primary', 'secondary']);
  });

  it('returns nothing when no windows are present', () => {
    expect(parseRateLimitWindows({ planType: 'free' })).toEqual([]);
  });
});

describe('toApprovalResponse', () => {
  it('accepts a command approval', () => {
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.commandExecutionApproval, { behavior: 'allow' }),
    ).toEqual({ decision: 'accept' });
  });

  it('persists an approval scoped to the session', () => {
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.commandExecutionApproval, {
        behavior: 'allow',
        scope: 'session',
      }),
    ).toEqual({ decision: 'acceptForSession' });
  });

  it('treats an "always allow" rule update as a session approval', () => {
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.fileChangeApproval, {
        behavior: 'allow',
        updatedPermissions: [
          { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'ApplyPatch' }], scope: 'session' },
        ],
      }),
    ).toEqual({ decision: 'acceptForSession' });
  });

  it('declines on a denial', () => {
    for (const method of [
      CODEX_SERVER_REQUEST.commandExecutionApproval,
      CODEX_SERVER_REQUEST.fileChangeApproval,
    ]) {
      expect(toApprovalResponse(method, { behavior: 'deny' })).toEqual({ decision: 'decline' });
    }
  });

  it('answers a permissions request in its own vocabulary, not with a decision', () => {
    // This is the whole reason the translation is per-request-kind: the
    // permissions request expects a granted subset and a scope, and would not
    // understand `{ decision: 'accept' }`.
    const requested: JsonValue = [{ kind: 'network', hosts: ['registry.npmjs.org'] }];

    // An allow echoes the requested set back as the grant. The answer to this
    // request *is* the granted list — an allow that returned `[]` would grant
    // nothing, turning the user's Allow click into a refusal wearing the
    // transcript's approval.
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.permissionsApproval, { behavior: 'allow' }, requested),
    ).toEqual({ permissions: requested, scope: 'turn' });

    expect(
      toApprovalResponse(
        CODEX_SERVER_REQUEST.permissionsApproval,
        { behavior: 'allow', scope: 'session' },
        requested,
      ),
    ).toEqual({ permissions: requested, scope: 'session' });

    // A request that named nothing still gets a well-formed answer.
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.permissionsApproval, { behavior: 'allow' }),
    ).toEqual({ permissions: [], scope: 'turn' });

    // A denial grants the empty set no matter what was asked for.
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.permissionsApproval, { behavior: 'deny' }, requested),
    ).toEqual({ permissions: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* Permission lifecycle on the stream                                         */
/* -------------------------------------------------------------------------- */

/** Which script the scripted app server follows. */
type FakeScenario = 'approval' | 'turn' | 'missing-rollout' | 'steer-reject';

/**
 * A scripted stand-in for `codex app-server`, speaking just enough of the
 * protocol to play one scenario:
 *
 *  - `approval` parks a run on one command-execution approval: it answers the
 *    handshake, opens a thread and a turn, then sends a single approval
 *    request and goes quiet.
 *  - `turn` plays a full turn lifecycle — `thread/started`, `turn/started`,
 *    `turn/completed` — so a run reaches `run.end` on its own. `thread/resume`
 *    behaves as 0.147 really does, probed live: the thread comes back in the
 *    response, nothing announces it, and the thread's prior token usage is
 *    replayed in the same flush.
 *  - `missing-rollout` refuses `thread/resume` with the verbatim wording
 *    Codex 0.147 uses when a thread's rollout file is gone.
 *  - `steer-reject` opens a turn that never completes and refuses
 *    `turn/steer`, so `send()`'s failure path is reachable.
 *
 * Everything else it is asked gets a `result: null`, which is what lets
 * `turn/interrupt` during dispose come back cleanly. Every frame it receives
 * is appended to a JSONL file first, so a test can assert on what the adapter
 * actually sent — for the resume path, *which* method went on the wire is the
 * decision under test.
 *
 * The shebang pins the exact Node running this test, so the fake needs no
 * PATH lookup to start. Windows ignores it — see {@link writeFakeExecutable}.
 */
function fakeAppServerScript(scenario: FakeScenario, framesPath: string): string {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const SCENARIO = ${JSON.stringify(scenario)};
const FRAMES = ${JSON.stringify(framesPath)};
let buffer = '';
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const handle = (message) => {
  fs.appendFileSync(FRAMES, JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') {
    write({ id: message.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (message.method === 'thread/start') {
    write({ id: message.id, result: { thread: { id: 'thread-1' } } });
    if (SCENARIO !== 'approval') {
      write({ method: 'thread/started', params: { thread: { id: 'thread-1', cwd: process.cwd() } } });
    }
    return;
  }
  if (message.method === 'thread/resume') {
    if (SCENARIO === 'missing-rollout') {
      write({
        id: message.id,
        error: { code: -32600, message: 'no rollout found for thread id ' + message.params.threadId },
      });
      return;
    }
    // Verbatim 0.147, probed live: the response carries the thread and
    // *nothing announces it* — no thread/started — while the thread's token
    // usage from previous turns is replayed immediately. One write, so both
    // frames land in one chunk the way a real pipe delivers them.
    process.stdout.write(
      JSON.stringify({
        id: message.id,
        result: {
          thread: { id: message.params.threadId, cwd: process.cwd(), cliVersion: '0.147.0' },
        },
      }) + '\\n' + JSON.stringify({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: message.params.threadId,
          turnId: 'turn-0',
          tokenUsage: {
            total: { totalTokens: 110, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
            last: { totalTokens: 110, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
          },
        },
      }) + '\\n',
    );
    return;
  }
  if (message.method === 'turn/start') {
    write({ id: message.id, result: { turn: { id: 'turn-1' } } });
    if (SCENARIO === 'approval') {
      write({
        id: 999,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          command: 'rm -rf ./build',
          cwd: process.cwd(),
        },
      });
      return;
    }
    write({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    if (SCENARIO === 'turn') {
      write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    }
    return;
  }
  if (message.method === 'turn/steer' && SCENARIO === 'steer-reject') {
    write({ id: message.id, error: { code: -32600, message: 'steer refused: no live turn' } });
    return;
  }
  if (typeof message.method === 'string' && message.id !== undefined) {
    write({ id: message.id, result: null });
  }
  // Notifications ('initialized') and the answer to our approval need no reply.
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== '') handle(JSON.parse(line));
    index = buffer.indexOf('\\n');
  }
});
// A closed pipe is the end of the run. On Windows the process that gets killed
// on dispose is the shim, not this, and a survivor holds the run directory open
// against the cleanup that follows.
process.stdin.on('end', () => process.exit(0));
`;
}

/**
 * Write the fake where the adapter can actually launch it, and say how.
 *
 * A shebang is how a POSIX kernel is told which interpreter to use, and Windows
 * has no equivalent: `CreateProcess` reads the file as an image, finds text, and
 * refuses. What Windows does have is the `.cmd` shim every npm-installed CLI
 * ships as — which is exactly what a Codex install puts on `PATH` there, and
 * exactly what `spawnJsonRpcSubprocess` learned to launch.
 */
async function writeFakeExecutable(
  dir: string,
  scenario: FakeScenario,
  framesPath: string,
): Promise<string> {
  const script = path.join(dir, 'fake-codex.cjs');
  await writeFile(script, fakeAppServerScript(scenario, framesPath), { mode: 0o755 });
  if (process.platform !== 'win32') return script;

  const shim = path.join(dir, 'fake-codex.cmd');
  await writeFile(shim, `@"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`);
  return shim;
}

interface FakeRunHarness {
  readonly run: Run;
  readonly events: readonly AgentEvent[];
  /** Resolve the first event matching `predicate`, seen already or still to come. */
  waitFor(predicate: (event: AgentEvent) => boolean): Promise<AgentEvent>;
  /** Every frame the fake has received so far, parsed, in arrival order. */
  frames(): Promise<readonly Record<string, unknown>[]>;
  cleanup(): Promise<void>;
}

interface StartFakeRunOptions {
  readonly scenario?: FakeScenario;
  readonly resumeSessionId?: SessionId;
}

/** Start a real CodexRun against the scripted server, with its stream pumped. */
async function startFakeRun(options?: StartFakeRunOptions): Promise<FakeRunHarness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'artemis-codex-fake-'));
  const framesPath = path.join(dir, 'frames.jsonl');
  const executable = await writeFakeExecutable(dir, options?.scenario ?? 'approval', framesPath);
  const codexHome = path.join(dir, 'home');
  await mkdir(codexHome);

  const adapter = createCodexAdapter({ executable });
  const run = await adapter.createRun({
    providerId: 'codex',
    profileId: PROFILE,
    cwd: dir,
    prompt: 'build the thing',
    runId: 'run-fake' as RunId,
    env: { [CODEX_HOME_ENV]: codexHome },
    ...(options?.resumeSessionId === undefined
      ? {}
      : { resumeSessionId: options.resumeSessionId }),
  });

  const events: AgentEvent[] = [];
  const waiters: Array<{
    predicate: (event: AgentEvent) => boolean;
    resolve: (event: AgentEvent) => void;
  }> = [];

  const pumpDone = (async () => {
    for await (const event of run.events) {
      events.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
  })();

  const waitFor = (predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> => {
    const seen = events.find(predicate);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<AgentEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `No matching event within 10s. Saw: ${events.map((event) => event.type).join(', ')}`,
          ),
        );
      }, 10_000);
      waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  };

  // The fake appends each frame before it answers, so by the time an event
  // provoked by a request reaches this side, the request is on disk.
  const frames = async (): Promise<readonly Record<string, unknown>[]> => {
    const text = await readFile(framesPath, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const cleanup = async (): Promise<void> => {
    await run.dispose();
    await pumpDone;
    await rm(dir, { recursive: true, force: true });
  };

  return { run, events, waitFor, frames, cleanup };
}

describe('CodexRun — permission.resolved on the stream', () => {
  /*
   * Why these exist: answering a prompt is an IPC call, invisible to any
   * consumer that was not the caller. The event stream is the account a
   * reloaded renderer replays, and without a `permission.resolved` for every
   * way a request ends, every replayed `permission.request` reads as still
   * open — the user is re-asked a question that was already answered, and
   * answering the ghost fails. See `PermissionResolvedEvent`.
   */

  it('emits allowed when the user approves', async () => {
    const harness = await startFakeRun();
    try {
      const request = await harness.waitFor((event) => event.type === 'permission.request');
      if (request.type !== 'permission.request') throw new Error('unreachable');

      await harness.run.respondToPermission(request.requestId, { behavior: 'allow' });

      const resolved = await harness.waitFor((event) => event.type === 'permission.resolved');
      if (resolved.type !== 'permission.resolved') throw new Error('unreachable');
      expect(resolved.requestId).toBe(request.requestId);
      expect(resolved.outcome).toBe('allowed');
    } finally {
      await harness.cleanup();
    }
  });

  it('emits denied, carrying the user’s message, when the user refuses', async () => {
    const harness = await startFakeRun();
    try {
      const request = await harness.waitFor((event) => event.type === 'permission.request');
      if (request.type !== 'permission.request') throw new Error('unreachable');

      await harness.run.respondToPermission(request.requestId, {
        behavior: 'deny',
        message: 'not on this branch',
      });

      const resolved = await harness.waitFor((event) => event.type === 'permission.resolved');
      if (resolved.type !== 'permission.resolved') throw new Error('unreachable');
      expect(resolved.requestId).toBe(request.requestId);
      expect(resolved.outcome).toBe('denied');
      expect(resolved.note).toBe('not on this branch');
    } finally {
      await harness.cleanup();
    }
  });

  it('withdraws a pending request on dispose, before run.end', async () => {
    const harness = await startFakeRun();
    try {
      const request = await harness.waitFor((event) => event.type === 'permission.request');
      if (request.type !== 'permission.request') throw new Error('unreachable');

      await harness.run.dispose();
      await harness.waitFor((event) => event.type === 'run.end');

      const resolved = harness.events.find((event) => event.type === 'permission.resolved');
      if (resolved?.type !== 'permission.resolved') throw new Error('no permission.resolved emitted');
      expect(resolved.requestId).toBe(request.requestId);
      // `withdrawn`, not `denied`: nobody answered, and a transcript recording
      // this as the user's refusal would be lying about who decided.
      expect(resolved.outcome).toBe('withdrawn');
      expect(resolved.note).toBe(DISPOSED_DENY_MESSAGE);

      // The resolution must land on the stream, ahead of the terminal event.
      const types = harness.events.map((event) => event.type);
      expect(types.indexOf('permission.resolved')).toBeLessThan(types.indexOf('run.end'));
    } finally {
      await harness.cleanup();
    }
  });
});

describe('CodexRun — resuming a thread', () => {
  /*
   * Why these exist: `resumeSessionId` is the seam every follow-up message in
   * an existing Codex conversation goes through, and nothing at the adapter
   * level proved what it puts on the wire. "Cannot send follow-up messages in
   * Codex sessions" is the failure these pin down from both ends — the
   * request that must be `thread/resume` rather than a fresh `thread/start`,
   * and what the user is told when the server has no rollout left to resume.
   */

  const RESUME_ID = 'thread-9' as SessionId;

  it('opens a fresh run with thread/start and never thread/resume', async () => {
    const harness = await startFakeRun({ scenario: 'turn' });
    try {
      const end = await harness.waitFor((event) => event.type === 'run.end');
      if (end.type !== 'run.end') throw new Error('unreachable');
      expect(end.reason).toBe('completed');

      const methods = (await harness.frames()).map((frame) => frame['method']);
      expect(methods).toContain('thread/start');
      expect(methods).not.toContain('thread/resume');
    } finally {
      await harness.cleanup();
    }
  });

  it('resumes with thread/resume, naming the stored thread id', async () => {
    const harness = await startFakeRun({ scenario: 'turn', resumeSessionId: RESUME_ID });
    try {
      await harness.waitFor((event) => event.type === 'run.end');

      const frames = await harness.frames();
      expect(frames.map((frame) => frame['method'])).not.toContain('thread/start');
      const resume = frames.find((frame) => frame['method'] === 'thread/resume');
      expect(resume?.['params']).toMatchObject({ threadId: RESUME_ID });
      // The turn must go to the resumed thread, not to a fresh one.
      const turn = frames.find((frame) => frame['method'] === 'turn/start');
      expect(turn?.['params']).toMatchObject({ threadId: RESUME_ID });
    } finally {
      await harness.cleanup();
    }
  });

  it('announces the resumed session with resumedFrom, and completes', async () => {
    /*
     * The reported bug, reproduced: 0.147 sends no `thread/started` for a
     * resumed thread, so an adapter waiting for the notification never emits
     * `session.started` — no session id is recorded, `send()` has no thread
     * to name, and every follow-up message fails. The announcement has to
     * come from the `thread/resume` response instead, and it has to come
     * *first*: the usage replayed alongside the response belongs to turns
     * already paid for, not to this run.
     */
    const harness = await startFakeRun({ scenario: 'turn', resumeSessionId: RESUME_ID });
    try {
      const started = await harness.waitFor((event) => event.type === 'session.started');
      if (started.type !== 'session.started') throw new Error('unreachable');
      expect(started.sessionId).toBe(RESUME_ID);
      expect(started.resumedFrom).toBe(RESUME_ID);

      const end = await harness.waitFor((event) => event.type === 'run.end');
      if (end.type !== 'run.end') throw new Error('unreachable');
      expect(end.reason).toBe('completed');

      expect(harness.events[0]?.type).toBe('session.started');
      // The replayed pre-turn usage is dropped, not re-reported: emitting it
      // would put `usage` ahead of `session.started` and count the previous
      // turns' tokens into this run's final total.
      expect(harness.events.some((event) => event.type === 'usage')).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it('says the history is gone when the rollout is missing, not "transport"', async () => {
    /*
     * The server's answer for a deleted — or never-persisted — rollout is a
     * -32600 whose message is the only signal (see `isMissingRollout`). Left
     * to `#connect`'s generic catch, that surfaced as an opaque `transport`
     * error naming the wire method and a JSON-RPC code; the user trying to
     * continue a conversation was told nothing actionable. The honest answer
     * is that the thread's history no longer exists and a new conversation is
     * the way forward.
     */
    const harness = await startFakeRun({
      scenario: 'missing-rollout',
      resumeSessionId: RESUME_ID,
    });
    try {
      const end = await harness.waitFor((event) => event.type === 'run.end');
      if (end.type !== 'run.end') throw new Error('unreachable');
      expect(end.reason).toBe('error');
      expect(end.error?.code).toBe('invalid_request');
      expect(end.error?.message).toBe(
        `Codex has no stored history for session ${RESUME_ID} — its rollout file is gone, so this conversation cannot be continued. Start a new conversation.`,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it('surfaces a rejected steer as a transport failure from send()', async () => {
    // Pins current behaviour: the server refusing `turn/steer` makes `send()`
    // throw rather than silently dropping the user's follow-up. The run
    // itself stays alive — only the steer failed.
    const harness = await startFakeRun({ scenario: 'steer-reject' });
    try {
      await harness.waitFor((event) => event.type === 'session.started');

      let thrown: unknown;
      try {
        await harness.run.send('and another thing');
      } catch (error) {
        thrown = error;
      }
      expect(isAdapterError(thrown)).toBe(true);
      if (!isAdapterError(thrown)) throw new Error('unreachable');
      expect(thrown.agentError.code).toBe('transport');
      expect(thrown.message).toMatch(/Could not steer the Codex turn/);
      expect(harness.events.some((event) => event.type === 'run.end')).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
