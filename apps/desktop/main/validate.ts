/**
 * Inbound IPC validation.
 *
 * The renderer is untrusted by construction. Not because we expect the user to
 * attack their own app, but because the renderer is the one process in Artemis
 * that displays attacker-influenced content: a transcript, a tool result, a
 * file the agent read. If anything ever achieves script execution there, this
 * file is the wall between it and the main process's filesystem access,
 * credential store and subprocess spawning.
 *
 * Two rules make that wall useful:
 *
 *  1. **Every payload is validated, not cast.** `ipcMain.handle` hands you
 *     `unknown`; a `as RunsStartRequest` would be a lie. Each validator below
 *     checks types, ranges and character sets before anything downstream sees
 *     the value.
 *
 *  2. **Every payload is rebuilt, not passed through.** Validators construct a
 *     fresh object containing only the fields the contract defines. A renderer
 *     cannot smuggle an extra property through to the Claude Agent SDK's
 *     `Options` by attaching it to a request — the field is simply dropped,
 *     because it was never copied across.
 *
 * Failures throw {@link ValidationError}, which the dispatcher turns into an
 * `invalid_request` result. Nothing here rejects a promise.
 */

import { isAbsolute } from 'node:path';

import type {
  RoutineDraft,
  RoutinePatch,
  RoutinesCreateRequest,
  RoutinesDeleteRequest,
  RoutinesListRequest,
  RoutinesRunNowRequest,
  RoutinesUpdateRequest,
} from '@rx-artemis/protocol';
import { gitCredentialUsernameProblem, gitRemoteProblem } from './gitCredentialEnv.js';
import { readSchedule } from './routines.js';

import {
  AGENT_PROMPTS_VERSION,
  AGENT_PROMPT_LIMITS,
  ATTACHMENT_LIMITS,
  attachmentBytes,
  base64Bytes,
  configDirProblem,
  BUILT_IN_PROMPT_IDS,
  isBuiltInPromptId,
  IMAGE_MEDIA_TYPES,
  isCredentialRoutingEnvKey,
  baseUrlProblem,
  isImageAttachment,
  isLocalProviderId,
  isImageMediaType,
  isPermissionMode,
  isProviderEffort,
  isProviderId,
  isSecretEnvKey,
  isValidServerPort,
  normalizeBaseUrl,
  normalizeWorkspace,
  MAX_SERVER_PORT,
  MIN_SERVER_PORT,
  normalizeProfileColor,
  normalizeProfilePlanId,
  profileColorProblem,
  profilePlanIdProblem,
  secretRefProblem,
  type AgentPrompt,
  type AgentPromptScope,
  type AgentPromptsListRequest,
  type AgentPromptsSaveRequest,
  type Attachment,
  type BuiltInPromptId,
  type MemoryBankAddRequest,
  type MemoryBankAuthInput,
  type MemoryBankForgetRequest,
  type MemoryBankMemoriesRequest,
  type MemoryBankRetireRequest,
  type MemoryBankSetEnabledRequest,
  type MemoryBankSyncRequest,
  type MemoryBankVerifyRemoteRequest,
  type MemoryBanksPreflightRequest,
  type MemoryBanksSetMasterEnabledRequest,
  type MemoryBanksStatusRequest,
  type SecretCredentialInput,
  type SecretRef,
  type SecretsConnectionDeleteRequest,
  type SecretsConnectionSaveRequest,
  type SecretsConnectionVerifyRequest,
  type SecretsConnectionsListRequest,
  type SecretsFetchServerCertRequest,
  type SecretsRefTestRequest,
  type FileAttachment,
  type ImageAttachment,
  type JsonObject,
  type JsonValue,
  type PermissionDecision,
  type PermissionRule,
  type PermissionRuleUpdate,
  type ProfileDraft,
  type ProfilePatch,
  type ProfilesCreateRequest,
  type ProfilesDeleteRequest,
  type ProfilesListRequest,
  type ProfilesSuggestDirRequest,
  type ProviderId,
  type ProfilesUpdateRequest,
  type ProvidersListRequest,
  type ProvidersCommandsRequest,
  type ProvidersModelsRequest,
  type QuestionAnswer,
  type RunInput,
  type RunsDisposeRequest,
  type RunsInterruptRequest,
  type RunsStopTaskRequest,
  type RunsEventsRequest,
  type RunsListRequest,
  type RemoteAccessConfigureRequest,
  type RemoteAccessStatusRequest,
  type RunsLiveWorkRequest,
  type RunsRespondPermissionRequest,
  type RunsSendRequest,
  type ServerCatalogueRequest,
  type ServerConfigureRequest,
  type ServerAllowance,
  type ServerCreateConnectionRequest,
  type ServerDeleteConnectionRequest,
  type ServerRenameConnectionRequest,
  type ServerWorkspace,
  type ServerStartRequest,
  type ServerStatusRequest,
  type ServerStopRequest,
  type RunsStartRequest,
  type SessionsListAllRequest,
  type SessionsListRequest,
  type SharedConfigStatusRequest,
  type SystemPromptSpec,
  type SessionsDeleteRequest,
  type SessionsMessagesRequest,
  type SessionsSubagentMessagesRequest,
  type SessionsRenameRequest,
  type AuthSignOutRequest,
  type AuthStatusRequest,
  type ServerAccountsRequest,
  type ServerAccountsCreateRequest,
  type ServerAccountsDeleteRequest,
  type ServerAccountsUpdateRequest,
  type ServerAccountSignInRequest,
  type ServerAccountSubmitCodeRequest,
  type UsagePlanRequest,
  type UpdatesCheckRequest,
  type UpdatesDismissRequest,
  type SessionsTagRequest,
  type UpdatesSetChannelRequest,
  type UpdatesInstallRequest,
  type UpdatesRestartRequest,
  type UpdatesStateRequest,
  type PreviewOpenRequest,
  type BrowserCloseRequest,
  type BrowserCommandRequest,
  type BrowserLayoutRequest,
  type BrowserListRequest,
  type BrowserNavigateRequest,
  type BrowserOpenRequest,
  type FilesCheckRequest,
  type GithubPullRequestsRequest,
  type PullRequestRef,
  type FilesListRequest,
  type FilesReadRequest,
  type TerminalCloseRequest,
  type TerminalListRequest,
  type TerminalReplayRequest,
  type TerminalResizeRequest,
  type TerminalStartRequest,
  type TerminalWriteRequest,
  type WindowRequest,
  type WorkspaceDescribeRequest,
  type WorkspacePickDirectoryRequest,
} from '@rx-artemis/protocol';

import { ValidationError } from './errors.js';

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Size ceilings.
 *
 * These exist to bound memory and to make an accidental infinite loop in the
 * renderer fail fast instead of filling the main process's heap. They are
 * generous — a one-megabyte prompt is far past anything a person types — and
 * none of them is a security boundary on its own.
 */
const LIMITS = {
  id: 200,
  label: 200,
  prompt: 1_000_000,
  text: 1_000_000,
  systemPrompt: 200_000,
  path: 4_096,
  model: 200,
  toolName: 200,
  denyMessage: 4_000,
  toolListItems: 512,
  directoryItems: 64,
  envEntries: 64,
  envKey: 128,
  envValue: 8_192,
  /** An endpoint key on its way to a server's store. Same bound as an env value. */
  secret: 8_192,
  ruleUpdates: 64,
  rulesPerUpdate: 256,
  /** Bound on one `owner` or `repo` segment. GitHub's own cap is 39/100. */
  repoSegment: 200,
  /**
   * Pull requests one request may ask about.
   *
   * A screenful of a transcript's links with room to spare. `github.ts` reads
   * them serially, so this also bounds how long one call holds that queue.
   */
  pullRequests: 64,
  /**
   * Profile ids one prompt's scope may name.
   *
   * A bound on a corrupt or hostile payload, not on a plausible one: the list
   * is built by ticking checkboxes against the profiles that exist, and nobody
   * has 256 accounts.
   */
  promptScopeProfiles: 256,
  /**
   * Bounds on an answered question prompt.
   *
   * Sized to the provider's schema (1–4 questions, 2–4 options) with room to
   * spare, not to what a person can be bothered to type. `answerNotes` is the
   * one field a user actually fills in, so it gets a paragraph's worth; the
   * adapter drops answers that name a question or an option the prompt never
   * offered, so the counts here only have to stop a runaway array.
   */
  answers: 16,
  answerOptions: 16,
  answerNotes: 4_000,
  metadataNodes: 256,
  metadataDepth: 8,
  jsonObjectNodes: 4_096,
  jsonObjectDepth: 12,
  maxTurns: 10_000,
  maxBudgetUsd: 100_000,
  pageSize: 1_000,
  /**
   * Bound for a page of *messages*, as against a page of session summaries.
   *
   * Deliberately far above {@link LIMITS.pageSize}: the caller that asks for a
   * bounded page of messages is a reloading window replaying everything before
   * a live run, and that number is however long the conversation is. A cap of a
   * thousand would refuse the request outright on a long session — worse than
   * the unbounded read the same channel already accepts when `limit` is
   * omitted, which is what opening any session from the sidebar does.
   */
  messagePage: 100_000,
  offset: 1_000_000,
  /**
   * Upper bound for a replay cursor.
   *
   * A run's `seq` counts events, not bytes, and the registry retains a
   * four-figure window of them — so anything near this is already a caller that
   * has lost track of what it is asking for rather than a long conversation.
   */
  seq: 1_000_000_000,
  /**
   * Transport bound for a session title, deliberately far above the length the
   * engine actually stores (`MAX_SESSION_TITLE`).
   *
   * The two limits do different jobs. This one rejects payloads no user
   * produced; the engine's truncates what a user *did* produce — someone
   * pasting a paragraph into the rename field wants a name out of it, not an
   * error about a character count no part of the UI shows them. Setting this
   * to the storage cap would turn that paste into a failure.
   */
  sessionTitle: 4_000,
  /**
   * Bound on one write into a terminal.
   *
   * Sized for a paste rather than for a keystroke — people paste log files into
   * `grep` — and small enough that a renderer looping on `write` fills a
   * megabyte at a time instead of the heap.
   */
  terminalData: 1_000_000,
  /**
   * Bound on a terminal's width and height, in cells.
   *
   * A 6K display at a 6px font is nowhere near a thousand columns, so anything
   * past this is a caller that has measured something other than a pane —
   * usually a detached element reporting zero, then a garbage number. The floor
   * of 1 matters as much as the ceiling: a PTY sized `0` makes `ioctl` fail and
   * some shells hang on it.
   */
  terminalDimension: 1_000,
  /**
   * Paths one `files.check` may ask about.
   *
   * Sized to a long answer rather than to a repository: the renderer batches the
   * path-shaped fragments of what is on screen, and two hundred of those in one
   * message is already an answer nobody is reading. It is a bound on work — each
   * entry costs a `stat` — and not on reach, since the same caller may send a
   * second request. See {@link validateFilesCheck}.
   */
  checkPaths: 256,
  /**
   * Longest address or query one browser request may carry.
   *
   * Matches the protocol's own `MAX_URL_LENGTH`, so a query this boundary
   * accepts is one `browserUrlFor` will at least attempt rather than refuse on
   * a length rule the caller never saw.
   */
  url: 4_096,
  /**
   * Envelope for a browser view's rectangle, in device-independent pixels.
   *
   * Far larger than any display, because it is not a statement about screens —
   * it is what keeps `Infinity`, `NaN` and `1e308` out of a native `setBounds`,
   * where they are a crash rather than a misdraw. The real bound on where a
   * page can be drawn is the window, and the window enforces it by clipping.
   */
  coordinate: 1_000_000,
} as const;

/**
 * Page size applied to `sessions.listAll` when the renderer omits `limit`.
 *
 * The protocol documents "omit for everything", and on a heavy account
 * "everything" is exactly what breaks: the merged history crosses the IPC
 * boundary through the leak scanner in `redact.ts`, whose scan gives up at
 * 50,000 nodes and fails *closed*. A session summary is ~13 nodes, so around
 * 3,800 sessions turned the whole sidebar into a false "credential-safety
 * check" error. Filling in a default page here keeps the response bounded —
 * 500 summaries is ~6,500 nodes, comfortably inside the budget — and
 * `hasMore` already tells the caller the history continues. An explicit
 * `limit` is still capped at {@link LIMITS.pageSize}, which at ~13,000 nodes
 * also stays well clear of the scan budget.
 */
const LIST_ALL_DEFAULT_LIMIT = 500;

/**
 * Character set for every identifier that crosses IPC — profile ids, run ids,
 * session ids, permission request ids.
 *
 * Wide enough for a uuid, a nanoid or a `profile_<hex>`; narrow enough that an
 * id can never be a path, a shell fragment or a JSON injection.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** POSIX-ish environment variable name. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys that must never be copied into an object built from renderer input. */
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const PERMISSION_SCOPES = new Set(['once', 'session', 'local', 'project', 'user']);
const PERMISSION_RULE_BEHAVIORS = new Set(['allow', 'deny', 'ask']);

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  // Structured clone always produces `Object.prototype`-rooted objects; anything
  // else came from somewhere it should not have.
  return proto === Object.prototype || proto === null;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValidationError(field, 'must be an object');
  return value;
}

/** The top-level request envelope. `undefined` is accepted as `{}`. */
function requireRequest(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return requireObject(value, 'request');
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ValidationError(field, 'must be a string');
  if (value.length === 0) throw new ValidationError(field, 'must not be empty');
  if (value.length > maxLength) throw new ValidationError(field, `must be at most ${maxLength} characters`);
  if (value.includes('\u0000')) throw new ValidationError(field, 'must not contain NUL bytes');
  return value;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, maxLength);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(field, 'must be a boolean');
  return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(field, 'must be an integer');
  }
  if (value < min || value > max) throw new ValidationError(field, `must be between ${min} and ${max}`);
  return value;
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = optionalInteger(value, field, min, max);
  if (parsed === undefined) throw new ValidationError(field, 'is required');
  return parsed;
}

function optionalFiniteNumber(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(field, 'must be a finite number');
  }
  if (value < min || value > max) throw new ValidationError(field, `must be between ${min} and ${max}`);
  return value;
}

function requireFiniteNumber(value: unknown, field: string, min: number, max: number): number {
  const parsed = optionalFiniteNumber(value, field, min, max);
  if (parsed === undefined) throw new ValidationError(field, 'is required');
  return parsed;
}

function requireId(value: unknown, field: string): string {
  const text = requireString(value, field, LIMITS.id);
  if (!ID_PATTERN.test(text)) throw new ValidationError(field, 'is not a valid identifier');
  return text;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireId(value, field);
}

/**
 * An absolute filesystem path.
 *
 * Absoluteness is required by the contract (`RunInput.cwd`), and it also stops
 * the agent's working directory from being resolved against whatever the main
 * process's `process.cwd()` happens to be at the time.
 */
function requireAbsolutePath(value: unknown, field: string): string {
  const text = requireString(value, field, LIMITS.path);
  if (!isAbsolute(text)) {
    // The detail is worth its length. This message is what a user sees after
    // typing a folder name into the working-directory field, and "must be an
    // absolute path" leaves them to work out what that means.
    throw new ValidationError(
      field,
      'must be an absolute path — a full path such as /Users/you/projects/app',
    );
  }
  return text;
}

function optionalAbsolutePath(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireAbsolutePath(value, field);
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > maxItems) throw new ValidationError(field, `must have at most ${maxItems} entries`);
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`, maxLength));
}

function optionalAbsolutePathArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > LIMITS.directoryItems) {
    throw new ValidationError(field, `must have at most ${LIMITS.directoryItems} entries`);
  }
  return value.map((entry, index) => requireAbsolutePath(entry, `${field}[${index}]`));
}

/** Drop keys whose value is `undefined`, so built payloads stay tidy. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/* -------------------------------------------------------------------------- */
/* JSON payloads                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Validate an arbitrary JSON payload (a tool input, run metadata).
 *
 * Rebuilds the value rather than returning it, so prototype-polluting keys are
 * dropped rather than merely detected, and so a hostile object with getters
 * cannot re-materialise after inspection.
 */
function validateJsonValue(
  value: unknown,
  field: string,
  budget: { nodes: number; readonly maxNodes: number; readonly maxDepth: number },
  depth = 0,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) {
    throw new ValidationError(field, `must contain at most ${budget.maxNodes} values`);
  }
  if (depth > budget.maxDepth) {
    throw new ValidationError(field, `must not nest deeper than ${budget.maxDepth} levels`);
  }

  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      if (value.length > LIMITS.text) throw new ValidationError(field, 'contains an oversized string');
      return value;
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new ValidationError(field, 'contains a non-finite number');
      return value;
    default:
      break;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => validateJsonValue(entry, `${field}[${index}]`, budget, depth + 1));
  }

  if (!isPlainObject(value)) throw new ValidationError(field, 'must contain only JSON values');

  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (key.length > LIMITS.envKey) throw new ValidationError(field, 'contains an oversized key');
    out[key] = validateJsonValue(entry, `${field}.${key}`, budget, depth + 1);
  }
  return out;
}

function optionalJsonObject(
  value: unknown,
  field: string,
  maxNodes: number,
  maxDepth: number,
): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new ValidationError(field, 'must be an object');
  return validateJsonValue(value, field, { nodes: 0, maxNodes, maxDepth }) as JsonObject;
}

/**
 * Non-sensitive environment variables for a profile.
 *
 * The checks here duplicate `@rx-artemis/core`'s. That is deliberate: `publicEnv` is
 * written to an unencrypted config file, so "someone pasted
 * `ANTHROPIC_AUTH_TOKEN` into the extra-env box" has to be caught before the
 * value reaches any layer that might persist it.
 *
 * The routing check is the one that earns its keep against a *hostile*
 * renderer rather than a careless user. `ANTHROPIC_BASE_URL` holds no secret
 * and reads as an innocuous setting, but `resolveEnv` writes the decrypted API
 * key into the same bundle it lands in, so accepting one here would hand the
 * key to whatever host the renderer named — with nothing sensitive ever
 * appearing in an IPC payload for the leak scanner to catch.
 */
function optionalPublicEnv(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const source = requireObject(value, field);
  const keys = Object.keys(source);
  if (keys.length > LIMITS.envEntries) {
    throw new ValidationError(field, `must have at most ${LIMITS.envEntries} entries`);
  }

  const out: Record<string, string> = {};
  for (const key of keys) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (!ENV_KEY_PATTERN.test(key) || key.length > LIMITS.envKey) {
      throw new ValidationError(`${field}.${key}`, 'is not a valid environment variable name');
    }
    if (isSecretEnvKey(key)) {
      throw new ValidationError(
        `${field}.${key}`,
        'looks like a credential. Store API keys in the profile’s key field, which is encrypted, ' +
          'rather than in the plain environment bundle',
      );
    }
    if (isCredentialRoutingEnvKey(key)) {
      throw new ValidationError(
        `${field}.${key}`,
        'controls where the profile’s credential is sent. Endpoint, proxy and TLS-trust ' +
          'variables are decided by Artemis, not by a profile',
      );
    }
    out[key] = requireString(source[key], `${field}.${key}`, LIMITS.envValue);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

function validatePermissionRules(value: unknown, field: string): readonly PermissionRule[] {
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > LIMITS.rulesPerUpdate) {
    throw new ValidationError(field, `must have at most ${LIMITS.rulesPerUpdate} entries`);
  }
  return value.map((entry, index) => {
    const rule = requireObject(entry, `${field}[${index}]`);
    return compact<PermissionRule>({
      toolName: requireString(rule['toolName'], `${field}[${index}].toolName`, LIMITS.toolName),
      ruleContent: optionalString(rule['ruleContent'], `${field}[${index}].ruleContent`, LIMITS.text),
    });
  });
}

function validateScope(value: unknown, field: string): PermissionRuleUpdate['scope'] {
  const scope = requireString(value, field, 32);
  if (!PERMISSION_SCOPES.has(scope)) throw new ValidationError(field, 'is not a valid permission scope');
  return scope as PermissionRuleUpdate['scope'];
}

function validateRuleBehavior(value: unknown, field: string): 'allow' | 'deny' | 'ask' {
  const behavior = requireString(value, field, 16);
  if (!PERMISSION_RULE_BEHAVIORS.has(behavior)) {
    throw new ValidationError(field, 'must be "allow", "deny" or "ask"');
  }
  return behavior as 'allow' | 'deny' | 'ask';
}

function validatePermissionRuleUpdate(value: unknown, field: string): PermissionRuleUpdate {
  const update = requireObject(value, field);
  const type = requireString(update['type'], `${field}.type`, 32);

  switch (type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return {
        type,
        behavior: validateRuleBehavior(update['behavior'], `${field}.behavior`),
        rules: validatePermissionRules(update['rules'], `${field}.rules`),
        scope: validateScope(update['scope'], `${field}.scope`),
      };

    case 'setMode': {
      const mode = update['mode'];
      if (!isPermissionMode(mode)) throw new ValidationError(`${field}.mode`, 'is not a valid permission mode');
      return { type, mode, scope: validateScope(update['scope'], `${field}.scope`) };
    }

    case 'addDirectories':
    case 'removeDirectories': {
      const directories = optionalAbsolutePathArray(update['directories'], `${field}.directories`);
      if (!directories) throw new ValidationError(`${field}.directories`, 'is required');
      return { type, directories, scope: validateScope(update['scope'], `${field}.scope`) };
    }

    default:
      throw new ValidationError(`${field}.type`, 'is not a known permission update type');
  }
}

function optionalRuleUpdates(value: unknown, field: string): readonly PermissionRuleUpdate[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > LIMITS.ruleUpdates) {
    throw new ValidationError(field, `must have at most ${LIMITS.ruleUpdates} entries`);
  }
  return value.map((entry, index) => validatePermissionRuleUpdate(entry, `${field}[${index}]`));
}

/**
 * Answers to a question prompt.
 *
 * Shape only. Whether an answer names a question that was asked, or an option
 * that was offered, is not checkable here — this layer does not hold the
 * pending request. The adapter does, and it drops anything that does not match
 * before the answers reach the provider.
 */
function optionalQuestionAnswers(
  value: unknown,
  field: string,
): readonly QuestionAnswer[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > LIMITS.answers) {
    throw new ValidationError(field, `must have at most ${String(LIMITS.answers)} entries`);
  }

  return value.map((entry, index) => {
    const answer = requireObject(entry, `${field}[${index}]`);
    return compact<QuestionAnswer>({
      question: requireString(answer['question'], `${field}[${index}].question`, LIMITS.text),
      options:
        optionalStringArray(
          answer['options'],
          `${field}[${index}].options`,
          LIMITS.answerOptions,
          LIMITS.text,
        ) ?? [],
      notes: optionalString(answer['notes'], `${field}[${index}].notes`, LIMITS.answerNotes),
    });
  });
}

function validatePermissionDecision(value: unknown, field: string): PermissionDecision {
  const decision = requireObject(value, field);
  const behavior = requireString(decision['behavior'], `${field}.behavior`, 16);

  if (behavior === 'allow') {
    return compact({
      behavior: 'allow' as const,
      updatedInput: optionalJsonObject(
        decision['updatedInput'],
        `${field}.updatedInput`,
        LIMITS.jsonObjectNodes,
        LIMITS.jsonObjectDepth,
      ),
      answers: optionalQuestionAnswers(decision['answers'], `${field}.answers`),
      updatedPermissions: optionalRuleUpdates(decision['updatedPermissions'], `${field}.updatedPermissions`),
      scope:
        decision['scope'] === undefined || decision['scope'] === null
          ? undefined
          : validateScope(decision['scope'], `${field}.scope`),
    });
  }

  if (behavior === 'deny') {
    return compact({
      behavior: 'deny' as const,
      message: optionalString(decision['message'], `${field}.message`, LIMITS.denyMessage),
      interrupt: optionalBoolean(decision['interrupt'], `${field}.interrupt`),
      updatedPermissions: optionalRuleUpdates(decision['updatedPermissions'], `${field}.updatedPermissions`),
    });
  }

  throw new ValidationError(`${field}.behavior`, 'must be "allow" or "deny"');
}

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A profile draft.
 *
 * Note what it no longer carries: a credential. There is no plaintext secret
 * anywhere in this IPC surface, in either direction, because Artemis stores
 * none — the provider's own login writes one into the config directory named
 * below and Artemis never sees it.
 */
function validateProfileDraft(value: unknown, field: string): ProfileDraft {
  const draft = requireObject(value, field);
  const providerId = draft['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError(`${field}.providerId`, 'is not a known provider');

  return compact<ProfileDraft>({
    label: requireString(draft['label'], `${field}.label`, LIMITS.label),
    providerId,
    configDir: requireConfigDir(draft['configDir'], `${field}.configDir`),
    publicEnv: optionalPublicEnv(draft['publicEnv'], `${field}.publicEnv`),
    /*
      Both only for a provider that is an address. A hosted account is reached
      through its own CLI's login, so a key sent with one would be a secret
      stored and encrypted for something that will never send it — and the
      whole reason Artemis stopped holding vendor credentials is that holding
      one it does not need is how the wrong account gets billed.

      Dropped rather than refused, unlike a malformed address: the renderer
      does not offer these fields for a hosted provider, so anything arriving
      here is a caller's confusion rather than a user's typo.
    */
    baseUrl: isLocalProviderId(providerId)
      ? optionalBaseUrl(draft['baseUrl'], `${field}.baseUrl`)
      : undefined,
    apiKey: isLocalProviderId(providerId)
      ? optionalApiKey(draft['apiKey'], `${field}.apiKey`)
      : undefined,
    color: optionalColor(draft['color'], `${field}.color`),
    planId: optionalPlanId(draft['planId'], providerId, `${field}.planId`),
    autoSelect: optionalBoolean(draft['autoSelect'], `${field}.autoSelect`),
    disabled: optionalBoolean(draft['disabled'], `${field}.disabled`),
  });
}

/**
 * Validate a local server's address.
 *
 * Rejected rather than dropped, for the reason the colour below is — this
 * boundary's job is to say what the renderer got wrong — and with more riding
 * on it: a dropped address would save a profile pointed at the flavour's
 * default while the editor showed the one the user typed.
 *
 * The empty string survives, as it does for the colour: it is how a patch says
 * "back to the default".
 */
function optionalBaseUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === '') return '';
  const address = requireString(value, field, LIMITS.path);
  const problem = baseUrlProblem(address);
  if (problem !== null) throw new ValidationError(field, problem);
  return normalizeBaseUrl(address);
}

/**
 * Validate an endpoint's key.
 *
 * The one plaintext secret this surface carries, and it carries it in one
 * direction only: renderer → main, once, when the user types it. Nothing sends
 * it back — the renderer is told `hasApiKey` and no more — and `redact.ts`
 * refuses the key name outright on anything outbound.
 *
 * Not trimmed. A key is whatever the server was started with, and quietly
 * removing whitespace from a secret is how a value that looks right fails to
 * authenticate. The empty string survives as the way to clear it.
 */
function optionalApiKey(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === '') return '';
  return requireString(value, field, LIMITS.path);
}

/**
 * Validate a swatch colour, normalised to `#rrggbb`.
 *
 * A rejection rather than a silent drop, even though the store would drop it
 * anyway and nothing breaks either way. This boundary's job is to say what the
 * renderer got wrong; quietly discarding a field would show the user a colour
 * they picked, save a profile without it, and give them nothing to go on.
 *
 * The empty string survives as the empty string — that is `ProfilePatch`'s way
 * of clearing a colour, and turning it into `undefined` here would silently
 * change "remove the colour" into "leave it alone".
 */
function optionalColor(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return '';
  const problem = profileColorProblem(value);
  if (problem !== null) throw new ValidationError(field, problem);
  return normalizeProfileColor(value) ?? undefined;
}

/**
 * Validate a pinned plan id against the plans Artemis knows.
 *
 * Rejected rather than dropped, on the same principle as the colour above: this
 * boundary states what it accepts. The difference is what a wrong value costs —
 * a bad colour shows the wrong swatch, whereas a plan id that quietly never
 * matches leaves a user who *has* told Artemis their plan looking at a ranking
 * that ignored them, with nothing on screen to explain why.
 *
 * The empty string is preserved rather than collapsed to `undefined`, because
 * it is the patch vocabulary for unpinning. See {@link ProfilePatch.planId}.
 */
function optionalPlanId(
  value: unknown,
  providerId: ProviderId | undefined,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return '';
  const problem = profilePlanIdProblem(value, providerId);
  if (problem !== null) throw new ValidationError(field, problem);
  return normalizeProfilePlanId(value, providerId) ?? undefined;
}

/**
 * Validate a config-directory path.
 *
 * The rules live in protocol's {@link configDirProblem}, and are applied from
 * that single definition in three places — here, in the profile store, and in
 * the editor while the user is still typing. So the boundary cannot drift from
 * what the form accepted, nor from what the store will agree to keep.
 */
function requireConfigDir(value: unknown, field: string): string {
  const problem = configDirProblem(value);
  if (problem !== null) throw new ValidationError(field, problem);
  const trimmed = (value as string).trim();
  if (trimmed.length > LIMITS.path) {
    throw new ValidationError(field, 'is implausibly long for a path');
  }
  return trimmed;
}

function optionalConfigDir(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireConfigDir(value, field);
}

function validateProfilePatch(value: unknown, field: string): ProfilePatch {
  const patch = requireObject(value, field);
  return compact<ProfilePatch>({
    label: optionalString(patch['label'], `${field}.label`, LIMITS.label),
    configDir: optionalConfigDir(patch['configDir'], `${field}.configDir`),
    publicEnv: optionalPublicEnv(patch['publicEnv'], `${field}.publicEnv`),
    baseUrl: optionalBaseUrl(patch['baseUrl'], `${field}.baseUrl`),
    apiKey: optionalApiKey(patch['apiKey'], `${field}.apiKey`),
    color: optionalColor(patch['color'], `${field}.color`),
    /*
      No provider to check against here, unlike the draft: a patch names only
      the fields it changes, and the profile it targets is the store's to
      resolve. So this boundary checks the id is a plan Artemis knows at all,
      and the store re-checks it against that profile's actual provider — the
      same two-stage rule `configDir` follows.
    */
    planId: optionalPlanId(patch['planId'], undefined, `${field}.planId`),
    /*
      Booleans with no clearing vocabulary, unlike the two fields above: absent
      means "leave it alone" and each of the two values is a state the caller
      can ask for outright. `optionalBoolean` rejects anything else rather than
      coercing it, so a `"disabled": "true"` from a confused caller cannot hide
      an account.
    */
    autoSelect: optionalBoolean(patch['autoSelect'], `${field}.autoSelect`),
    disabled: optionalBoolean(patch['disabled'], `${field}.disabled`),
  });
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

function optionalSystemPrompt(value: unknown, field: string): SystemPromptSpec | undefined {
  if (value === undefined || value === null) return undefined;
  const spec = requireObject(value, field);
  const kind = requireString(spec['kind'], `${field}.kind`, 16);
  switch (kind) {
    case 'default':
      return { kind: 'default' };
    case 'append':
    case 'replace':
      return { kind, text: requireString(spec['text'], `${field}.text`, LIMITS.systemPrompt) };
    default:
      throw new ValidationError(`${field}.kind`, 'must be "default", "append" or "replace"');
  }
}

/**
 * Base64 as the Messages API wants it: standard alphabet, correct padding, no
 * whitespace and no `data:` prefix.
 *
 * Checked by shape rather than by round-tripping through `Buffer`, because
 * `Buffer.from(x, 'base64')` does not validate — it discards anything outside
 * the alphabet and returns whatever it managed to decode. A payload that is
 * half base64 and half something else would sail through a decode check and
 * reach the provider as a corrupt image, or reach `writeFile` in an adapter as
 * a file whose contents nobody predicted.
 *
 * ## Why this is not one regex
 *
 * The obvious pattern is
 * `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`, where the
 * `{4}` group inside a `*` is what enforces the multiple-of-four length. That
 * is a **nested quantifier**, and V8 pushes a backtracking frame per repetition
 * — so on a payload of any real size it does not reject the input, it throws
 * `RangeError: Maximum call stack size exceeded`. That version shipped in the
 * image-only revision of this file and never fired, because five megabytes of
 * image was under the threshold; the first 8MB file attachment found it.
 *
 * So the length rule is arithmetic and the charset rule is a flat character
 * class, which is linear and allocates no frames. `=` appears only in the
 * trailing `={0,2}`, so padding still cannot appear in the middle.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/**
 * The base64 payload both attachment kinds carry.
 *
 * Size before shape: the regex is linear, but scanning a 40MB string before
 * refusing it is work done for a payload that was never going to be accepted.
 */
function requirePayload(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new ValidationError(field, 'must be a string');
  if (value.length === 0) throw new ValidationError(field, 'must not be empty');
  if (base64Bytes(value) > maxBytes) {
    throw new ValidationError(field, `must decode to at most ${String(maxBytes)} bytes`);
  }
  if (!isBase64(value)) {
    throw new ValidationError(field, 'must be base64 with no data: prefix');
  }
  return value;
}

/**
 * One image crossing IPC.
 *
 * The renderer enforces every one of these limits too, so the user finds out
 * while the image is still in the composer. That is a courtesy, not the
 * boundary: a renderer is not a trusted enforcer of its own limits, and this
 * is the last place the payload can be refused before it is written to a file
 * or billed to the user's account.
 */
function validateImageAttachment(value: unknown, field: string): ImageAttachment {
  const attachment = requireObject(value, field);

  const mediaType = attachment['mediaType'];
  if (!isImageMediaType(mediaType)) {
    throw new ValidationError(
      `${field}.mediaType`,
      `must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`,
    );
  }

  return compact<ImageAttachment>({
    kind: 'image',
    id: requireId(attachment['id'], `${field}.id`),
    mediaType,
    data: requirePayload(attachment['data'], `${field}.data`, ATTACHMENT_LIMITS.bytesPerImage),
    // A filename, so it is untrusted display text: length-capped like every
    // other label, and never used to build a path — staged images are named
    // after a counter for exactly this reason.
    name: optionalString(attachment['name'], `${field}.name`, ATTACHMENT_LIMITS.nameLength),
    width: optionalInteger(attachment['width'], `${field}.width`, 1, 1_000_000),
    height: optionalInteger(attachment['height'], `${field}.height`, 1, 1_000_000),
  });
}

/**
 * One file crossing IPC.
 *
 * No format check, deliberately — see {@link FileAttachment}. What is checked
 * is the one field that is *not* inert: `name` is required here (an image's is
 * optional) because the staged file is named after it, so a missing one is a
 * bug rather than a shrug. It is length-capped and NUL-checked by
 * `requireString`, and `safeFileName` in the core adapters reduces it to a
 * single safe path component before anything opens it. Two layers, because the
 * consequence of getting it wrong is a write outside the staging directory.
 */
function validateFileAttachment(value: unknown, field: string): FileAttachment {
  const attachment = requireObject(value, field);

  return compact<FileAttachment>({
    kind: 'file',
    id: requireId(attachment['id'], `${field}.id`),
    name: requireString(attachment['name'], `${field}.name`, ATTACHMENT_LIMITS.nameLength),
    // Free-form: browsers hand over whatever they like, including nothing, and
    // only `application/pdf` changes any behaviour downstream. Bounded so it
    // cannot be used as a smuggling channel, and otherwise passed through.
    mediaType: optionalString(attachment['mediaType'], `${field}.mediaType`, 200),
    data: requirePayload(attachment['data'], `${field}.data`, ATTACHMENT_LIMITS.bytesPerFile),
  });
}

function optionalAttachments(value: unknown, field: string): readonly Attachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length === 0) return undefined;
  // A cheap bound before anything is decoded, so a renderer sending ten
  // thousand entries is refused by a length check rather than by a loop.
  if (value.length > ATTACHMENT_LIMITS.images + ATTACHMENT_LIMITS.files) {
    throw new ValidationError(
      field,
      `must have at most ${String(ATTACHMENT_LIMITS.images + ATTACHMENT_LIMITS.files)} entries`,
    );
  }

  const attachments = value.map((entry, index): Attachment => {
    const at = `${field}[${index}]`;
    const kind = requireObject(entry, at)['kind'];
    if (kind === 'image') return validateImageAttachment(entry, at);
    if (kind === 'file') return validateFileAttachment(entry, at);
    throw new ValidationError(`${at}.kind`, 'must be "image" or "file"');
  });

  // Per kind, because the two have different ceilings for different reasons —
  // an image's bytes become tokens, a file's become a file.
  const images = attachments.filter(isImageAttachment).length;
  if (images > ATTACHMENT_LIMITS.images) {
    throw new ValidationError(field, `must have at most ${String(ATTACHMENT_LIMITS.images)} images`);
  }
  const files = attachments.length - images;
  if (files > ATTACHMENT_LIMITS.files) {
    throw new ValidationError(field, `must have at most ${String(ATTACHMENT_LIMITS.files)} files`);
  }

  // The per-attachment ceilings bound one payload; this bounds the request.
  // Ten files each just under the limit is ten times the memory of one, in the
  // main process, held while they are written to disk.
  const total = attachments.reduce((sum, attachment) => sum + attachmentBytes(attachment), 0);
  if (total > ATTACHMENT_LIMITS.bytesTotal) {
    throw new ValidationError(
      field,
      `must decode to at most ${String(ATTACHMENT_LIMITS.bytesTotal)} bytes in total`,
    );
  }

  // Duplicate ids would make the transcript's chips ambiguous and are never
  // something the composer produces.
  const ids = new Set(attachments.map((attachment) => attachment.id));
  if (ids.size !== attachments.length) {
    throw new ValidationError(field, 'must not contain two attachments with the same id');
  }

  return attachments;
}

function validateRunInput(value: unknown, field: string): RunInput {
  const input = requireObject(value, field);

  const providerId = input['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError(`${field}.providerId`, 'is not a known provider');

  const permissionMode = input['permissionMode'];
  if (permissionMode !== undefined && permissionMode !== null && !isPermissionMode(permissionMode)) {
    throw new ValidationError(`${field}.permissionMode`, 'is not a known permission mode');
  }

  // Shape only, exactly like `backend` and `authMode` on a profile: whether the
  // provider actually declares a level by this name is the adapter's question,
  // and the adapter answers it by rejecting the run rather than dropping the
  // setting. This boundary only proves it is an id and not a payload.
  const effort = input['effort'];
  if (effort !== undefined && effort !== null && !isProviderEffort(effort)) {
    throw new ValidationError(`${field}.effort`, 'is not a valid reasoning-effort id');
  }

  // The prompt is allowed to be empty — resuming a session to let the agent
  // continue is a real workflow — so it is length-checked rather than
  // required-non-empty.
  const prompt = input['prompt'];
  if (typeof prompt !== 'string') throw new ValidationError(`${field}.prompt`, 'must be a string');
  if (prompt.length > LIMITS.prompt) {
    throw new ValidationError(`${field}.prompt`, `must be at most ${LIMITS.prompt} characters`);
  }

  return compact<RunInput>({
    providerId,
    profileId: requireId(input['profileId'], `${field}.profileId`),
    cwd: requireAbsolutePath(input['cwd'], `${field}.cwd`),
    prompt,
    attachments: optionalAttachments(input['attachments'], `${field}.attachments`),
    runId: optionalId(input['runId'], `${field}.runId`),
    resumeSessionId: optionalId(input['resumeSessionId'], `${field}.resumeSessionId`),
    forkSession: optionalBoolean(input['forkSession'], `${field}.forkSession`),
    /*
     * An opaque provider id, not one of Artemis's own — Claude names stored
     * messages by chain uuid — so this is `optionalString` where its
     * neighbours are `optionalId`. Its absence from this whitelist was the
     * whole of the rewind bug: `compact` copies only the keys written here,
     * the field vanished on its way through IPC, and a "rewound" run silently
     * resumed the *full* conversation while the transcript on screen showed
     * the cut. The adapter validates the id against the stored chain; this
     * boundary only proves it is a short string.
     */
    rewindToMessageId: optionalString(input['rewindToMessageId'], `${field}.rewindToMessageId`, LIMITS.model),
    model: optionalString(input['model'], `${field}.model`, LIMITS.model),
    fallbackModel: optionalString(input['fallbackModel'], `${field}.fallbackModel`, LIMITS.model),
    permissionMode: permissionMode === null ? undefined : (permissionMode as RunInput['permissionMode']),
    effort: effort === null ? undefined : (effort as RunInput['effort']),
    allowedTools: optionalStringArray(
      input['allowedTools'],
      `${field}.allowedTools`,
      LIMITS.toolListItems,
      LIMITS.toolName,
    ),
    disallowedTools: optionalStringArray(
      input['disallowedTools'],
      `${field}.disallowedTools`,
      LIMITS.toolListItems,
      LIMITS.toolName,
    ),
    additionalDirectories: optionalAbsolutePathArray(
      input['additionalDirectories'],
      `${field}.additionalDirectories`,
    ),
    maxTurns: optionalInteger(input['maxTurns'], `${field}.maxTurns`, 1, LIMITS.maxTurns),
    maxBudgetUsd: optionalFiniteNumber(input['maxBudgetUsd'], `${field}.maxBudgetUsd`, 0, LIMITS.maxBudgetUsd),
    systemPrompt: optionalSystemPrompt(input['systemPrompt'], `${field}.systemPrompt`),
    title: optionalString(input['title'], `${field}.title`, LIMITS.label),
    includePartialMessages: optionalBoolean(input['includePartialMessages'], `${field}.includePartialMessages`),
    metadata: optionalJsonObject(input['metadata'], `${field}.metadata`, LIMITS.metadataNodes, LIMITS.metadataDepth),
  });
}

/* -------------------------------------------------------------------------- */
/* Request validators, one per channel                                        */
/* -------------------------------------------------------------------------- */

export function validateProfilesList(raw: unknown): ProfilesListRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (providerId === undefined || providerId === null) return {};
  if (!isProviderId(providerId)) throw new ValidationError('providerId', 'is not a known provider');
  return { providerId };
}

export function validateProfilesCreate(raw: unknown): ProfilesCreateRequest {
  const request = requireRequest(raw);
  return { draft: validateProfileDraft(request['draft'], 'draft') };
}

export function validateProfilesUpdate(raw: unknown): ProfilesUpdateRequest {
  const request = requireRequest(raw);
  return {
    id: requireId(request['id'], 'id'),
    patch: validateProfilePatch(request['patch'], 'patch'),
  };
}

export function validateProfilesDelete(raw: unknown): ProfilesDeleteRequest {
  const request = requireRequest(raw);
  return compact<ProfilesDeleteRequest>({
    id: requireId(request['id'], 'id'),
    deleteConfigDir: optionalBoolean(request['deleteConfigDir'], 'deleteConfigDir'),
  });
}

/**
 * A label to name a suggested directory after.
 *
 * Accepts an empty label — the create form calls this while the user is still
 * typing, and refusing the first keystroke would leave the field blank at the
 * exact moment it is most useful. The suggestion falls back to a generic name.
 */
export function validateProfilesSuggestDir(raw: unknown): ProfilesSuggestDirRequest {
  const request = requireRequest(raw);
  const label = request['label'];
  if (label !== undefined && typeof label !== 'string') {
    throw new ValidationError('label', 'must be a string');
  }
  return { label: (label ?? '').slice(0, LIMITS.label) };
}

export function validateProvidersList(raw: unknown): ProvidersListRequest {
  const request = requireRequest(raw);
  return compact<ProvidersListRequest>({ refresh: optionalBoolean(request['refresh'], 'refresh') });
}

/**
 * The live model catalogue.
 *
 * `providerId` and `profileId` get the same treatment they get in
 * {@link validateSessionsList}, and for the same reason: together they decide
 * which adapter runs and which credential it runs with. A `profileId` that is
 * merely well-formed is still checked against the store downstream, so this
 * only has to reject the shapes that would reach an adapter as garbage.
 *
 * `cwd` is optional here but absolute when present. The provider resolves its
 * configuration relative to it, so a relative path would be resolved against
 * the main process's `process.cwd()` — an artefact of how Artemis was launched,
 * and never what the renderer meant.
 */
export function validateProvidersModels(raw: unknown): ProvidersModelsRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError('providerId', 'is not a known provider');
  return compact<ProvidersModelsRequest>({
    providerId,
    profileId: requireId(request['profileId'], 'profileId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
  });
}

/**
 * The slash commands a session would offer.
 *
 * Field for field the same request as {@link validateProvidersModels}, with the
 * same reasoning behind each check — the two channels differ in what they ask
 * the provider, not in what they are told.
 */
export function validateProvidersCommands(raw: unknown): ProvidersCommandsRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError('providerId', 'is not a known provider');
  return compact<ProvidersCommandsRequest>({
    providerId,
    profileId: requireId(request['profileId'], 'profileId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
  });
}

export function validateRunsStart(raw: unknown): RunsStartRequest {
  const request = requireRequest(raw);
  return { input: validateRunInput(request['input'], 'input') };
}

export function validateRunsSend(raw: unknown): RunsSendRequest {
  const request = requireRequest(raw);
  const text = request['text'];
  if (typeof text !== 'string') throw new ValidationError('text', 'must be a string');
  if (text.length > LIMITS.text) throw new ValidationError('text', `must be at most ${LIMITS.text} characters`);
  return compact<RunsSendRequest>({
    runId: requireId(request['runId'], 'runId'),
    text,
    attachments: optionalAttachments(request['attachments'], 'attachments'),
  });
}

export function validateRunsInterrupt(raw: unknown): RunsInterruptRequest {
  const request = requireRequest(raw);
  return { runId: requireId(request['runId'], 'runId') };
}

export function validateRunsStopTask(raw: unknown): RunsStopTaskRequest {
  const request = requireRequest(raw);
  return {
    runId: requireId(request['runId'], 'runId'),
    // The provider's own id for the task, echoed back to it. Length-bounded like
    // every other id that crosses this boundary.
    taskId: requireId(request['taskId'], 'taskId'),
  };
}

export function validateRunsRespondPermission(raw: unknown): RunsRespondPermissionRequest {
  const request = requireRequest(raw);
  return {
    runId: requireId(request['runId'], 'runId'),
    requestId: requireId(request['requestId'], 'requestId'),
    decision: validatePermissionDecision(request['decision'], 'decision'),
  };
}

export function validateRunsDispose(raw: unknown): RunsDisposeRequest {
  const request = requireRequest(raw);
  return { runId: requireId(request['runId'], 'runId') };
}

export function validateRunsList(raw: unknown): RunsListRequest {
  const request = requireRequest(raw);
  return compact<RunsListRequest>({ cwd: optionalAbsolutePath(request['cwd'], 'cwd') });
}

/**
 * A request with no fields, still validated for shape.
 *
 * `requireRequest` is the whole check and it is not a formality: it rejects a
 * non-object, which is what stops a malformed payload reaching the handler and
 * failing there instead. Whatever else the caller sent is dropped rather than
 * forwarded — the empty object is the contract.
 */
export function validateRunsLiveWork(raw: unknown): RunsLiveWorkRequest {
  requireRequest(raw);
  return {};
}

/**
 * `-1` is the floor rather than `0` because it is the natural spelling of
 * "everything you still have": `seq` starts at 0, and a caller that has applied
 * nothing has no event to name. Omitting the field means the same thing.
 */
export function validateRunsEvents(raw: unknown): RunsEventsRequest {
  const request = requireRequest(raw);
  return compact<RunsEventsRequest>({
    runId: requireId(request['runId'], 'runId'),
    afterSeq: optionalInteger(request['afterSeq'], 'afterSeq', -1, LIMITS.seq),
  });
}

export function validateSessionsList(raw: unknown): SessionsListRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError('providerId', 'is not a known provider');
  return compact<SessionsListRequest>({
    providerId,
    profileId: requireId(request['profileId'], 'profileId'),
    cwd: requireAbsolutePath(request['cwd'], 'cwd'),
    limit: optionalInteger(request['limit'], 'limit', 1, LIMITS.pageSize),
    offset: optionalInteger(request['offset'], 'offset', 0, LIMITS.offset),
  });
}

/**
 * The aggregated listing.
 *
 * Note what is *absent*: no profile id and no cwd. Both are answers this query
 * produces rather than inputs it takes — the renderer cannot ask for another
 * profile's history because it does not name a profile at all. `providerId` is
 * the one filter, and it is optional.
 */
export function validateSessionsListAll(raw: unknown): SessionsListAllRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (providerId !== undefined && providerId !== null && !isProviderId(providerId)) {
    throw new ValidationError('providerId', 'is not a known provider');
  }
  return compact<SessionsListAllRequest>({
    providerId: providerId === undefined || providerId === null ? undefined : providerId,
    // An omitted limit becomes a default page rather than "everything" — see
    // {@link LIST_ALL_DEFAULT_LIMIT} for why an unbounded merged history is a
    // request this boundary must not forward.
    limit: optionalInteger(request['limit'], 'limit', 1, LIMITS.pageSize) ?? LIST_ALL_DEFAULT_LIMIT,
    offset: optionalInteger(request['offset'], 'offset', 0, LIMITS.offset),
  });
}

/**
 * The directory picker.
 *
 * `defaultPath` only decides where the dialog opens; the user still has to
 * choose. It is required to be absolute all the same — a relative path would
 * be resolved against the main process's `process.cwd()`, which is an
 * implementation detail of how Artemis was launched and has nothing to do with
 * anything the user can see.
 *
 * The dialog's title and button text are deliberately **not** accepted. They
 * are copy in a native OS window, and letting the renderer write them would
 * make a system dialog say whatever renderer script wanted it to say.
 */
export function validateWorkspacePickDirectory(raw: unknown): WorkspacePickDirectoryRequest {
  const request = requireRequest(raw);
  return compact<WorkspacePickDirectoryRequest>({
    defaultPath: optionalAbsolutePath(request['defaultPath'], 'defaultPath'),
  });
}

/** Naming a directory. Absolute, because there is nothing to resolve against. */
export function validateWorkspaceDescribe(raw: unknown): WorkspaceDescribeRequest {
  const request = requireRequest(raw);
  return { path: requireAbsolutePath(request['path'], 'path') };
}

/**
 * Reading the shared-config links: nothing at all, and that is the whole
 * security story for the channel.
 *
 * Held to the same standard as {@link validateWindowRequest} and returning a
 * fresh empty object for the same reason — a renderer that attaches a `dirs`
 * array finds it dropped before the handler could read it. The handler derives
 * the directories from the profile store, so this channel cannot be pointed at a
 * path, and there is no validator here that could accidentally permit one.
 */
export function validateSharedConfigStatus(raw: unknown): SharedConfigStatusRequest {
  requireRequest(raw);
  return {};
}

/**
 * Opening a preview.
 *
 * Absolute for the same reason every other path here is: a relative one would
 * resolve against the main process's `process.cwd()`, which is an artefact of
 * how Artemis was launched rather than anywhere the user has been.
 *
 * What is *not* checked here is which extensions may be previewed. That belongs
 * to `preview.ts`, which is the layer that knows what it can serve, and keeping
 * the list in one place means a validator and a handler can never disagree about
 * it — the failure mode being a file that passes validation and is then refused
 * with a different error.
 */
export function validatePreviewOpen(raw: unknown): PreviewOpenRequest {
  const request = requireRequest(raw);
  return { path: requireAbsolutePath(request['path'], 'path') };
}

/**
 * Reading a file as text.
 *
 * The same one check as {@link validatePreviewOpen}, and for the same reason: a
 * relative path would resolve against the main process's `process.cwd()`, which
 * is wherever Artemis happened to be launched from. Resolving a transcript's
 * relative path against the *conversation's* directory is the renderer's job,
 * because the renderer is the only side that knows which conversation the click
 * came from.
 *
 * Nothing here decides what may be read. Whether a file is text, how much of it
 * comes back, and what to say when it is a folder all belong to `files.ts`,
 * which is the layer that has the bytes — see {@link validatePreviewOpen} for
 * the argument that a validator and a handler holding two copies of one rule
 * will eventually disagree about it.
 */
/**
 * Listing a directory.
 *
 * Exactly {@link validateFilesRead}'s gate, because it is exactly the same
 * reach: anything this can name, the read could already open. A looser rule
 * here would be the interesting one to find.
 */
export function validateFilesList(raw: unknown): FilesListRequest {
  const request = requireRequest(raw);
  return { path: requireAbsolutePath(request['path'], 'path') };
}

export function validateFilesRead(raw: unknown): FilesReadRequest {
  const request = requireRequest(raw);
  return { path: requireAbsolutePath(request['path'], 'path') };
}

/**
 * Asking which of a batch of paths are files.
 *
 * Every path gets exactly the treatment {@link validateFilesRead} gives its one,
 * because the two channels are pointed at the same disk by the same caller and a
 * looser gate on the cheaper question would be the interesting one to find.
 *
 * {@link LIMITS.checkPaths} is the only rule that is new here, and it is a bound
 * on work rather than on reach: the renderer batches one screenful of an answer
 * into a request, and a cap keeps a loop in a compromised one from asking for a
 * hundred thousand `stat`s in a single call. An honest caller with more than a
 * batch's worth sends a second request, which is what the renderer does.
 *
 * An empty list is accepted and answers with an empty list. It is what a caller
 * that deduplicated its way down to nothing sends, and refusing it would mean
 * the renderer having to know not to.
 */
export function validateFilesCheck(raw: unknown): FilesCheckRequest {
  const request = requireRequest(raw);
  const paths = request['paths'];
  if (!Array.isArray(paths)) throw new ValidationError('paths', 'must be an array');
  if (paths.length > LIMITS.checkPaths) {
    throw new ValidationError('paths', `must have at most ${LIMITS.checkPaths} entries`);
  }
  return { paths: paths.map((entry, index) => requireAbsolutePath(entry, `paths[${index}]`)) };
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One `owner` or `repo` on its way to becoming a subprocess argument.
 *
 * This is the validator that matters most in this file's terms, because these
 * two strings come from a URL that an *agent* wrote. Prompt injection reaches
 * exactly this far: text in a tool result becomes a link in a transcript becomes
 * an argument to `execFile`.
 *
 * The character classes are GitHub's own and are the same ones
 * `parsePullRequestUrl` applies in the renderer. That duplication is deliberate
 * and is this file's whole thesis — the renderer's parse is a *convenience* that
 * decides whether to draw a link, and it runs in the process that is untrusted
 * by construction. This copy is the gate.
 *
 * `github.ts` never uses a shell, so there is no metacharacter to escape and
 * this is not the only thing standing between a crafted name and execution. It
 * is the one that means a name which could not be a repository never becomes an
 * argument at all — including a leading `-`, which is an option rather than a
 * value to every CLI ever written.
 */
function requireRepoSegment(value: unknown, field: string, pattern: RegExp): string {
  const text = requireString(value, field, LIMITS.repoSegment);
  if (!pattern.test(text)) throw new ValidationError(field, 'is not a GitHub name');
  return text;
}

const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Asking where a batch of pull requests stands.
 *
 * The shape of {@link validateFilesCheck}, and the cap does the same job: one
 * screenful of a transcript's links, and a bound so a loop in a compromised
 * renderer cannot ask for ten thousand subprocesses in a single call. `github.ts`
 * walks the batch serially, so the cap is also a bound on how long one call can
 * occupy the queue.
 *
 * An empty list is accepted and answers with an empty list, for the reason the
 * channel above gives.
 */
export function validateGithubPullRequests(raw: unknown): GithubPullRequestsRequest {
  const request = requireRequest(raw);
  const refs = request['refs'];
  if (!Array.isArray(refs)) throw new ValidationError('refs', 'must be an array');
  if (refs.length > LIMITS.pullRequests) {
    throw new ValidationError('refs', `must have at most ${LIMITS.pullRequests} entries`);
  }

  return {
    refs: refs.map((entry, index): PullRequestRef => {
      const ref = requireObject(entry, `refs[${index}]`);
      return {
        owner: requireRepoSegment(ref['owner'], `refs[${index}].owner`, GITHUB_OWNER),
        repo: requireRepoSegment(ref['repo'], `refs[${index}].repo`, GITHUB_REPO),
        // Upper bound is a sanity rail rather than a real limit — the busiest
        // repository on GitHub has not passed a quarter of a million PRs — and
        // the lower one refuses `0`, which is not a pull request anywhere.
        number: requireInteger(ref['number'], `refs[${index}].number`, 1, 10_000_000),
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Browsers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Open a page.
 *
 * `query` is what somebody typed and is **not** validated as a URL here, which
 * looks like a gap and is the opposite of one. `browser.ts` runs `browserUrlFor`
 * over it and refuses anything that is not `http(s)` — so there is exactly one
 * copy of that rule, in the layer that acts on it. A second copy here could
 * only ever disagree with the first, and the failure mode of disagreement is a
 * scheme this boundary permits and the loader does not, or worse the reverse.
 *
 * What is checked is what this layer is for: that it is a bounded string. The
 * length cap matches the protocol's own so a query that could never resolve is
 * refused before it reaches a regular expression.
 */
export function validateBrowserOpen(raw: unknown): BrowserOpenRequest {
  const request = requireRequest(raw);
  return compact<BrowserOpenRequest>({
    query: optionalString(request['query'], 'query', LIMITS.url),
  });
}

export function validateBrowserNavigate(raw: unknown): BrowserNavigateRequest {
  const request = requireRequest(raw);
  return {
    id: requireId(request['id'], 'id'),
    query: requireString(request['query'], 'query', LIMITS.url),
  };
}

export function validateBrowserCommand(raw: unknown): BrowserCommandRequest {
  const request = requireRequest(raw);
  const command = requireString(request['command'], 'command', 16);
  if (!BROWSER_COMMANDS.has(command)) {
    throw new ValidationError('command', 'must be "back", "forward", "reload" or "stop"');
  }
  return { id: requireId(request['id'], 'id'), command: command as BrowserCommandRequest['command'] };
}

/**
 * Where a page goes.
 *
 * The one channel in this file that carries geometry, and the only one that is
 * called on every frame of a drag — so the checks are the cheap kind. Bounds
 * are finite numbers within a window-sized envelope: {@link LIMITS.coordinate}
 * is far larger than any display and exists to keep an `Infinity` or a `1e308`
 * out of a native `setBounds`, which is a crash rather than a misdraw.
 *
 * Negative `x`/`y` are legal and load-bearing: a pane scrolled under the header
 * genuinely has a negative offset, and clamping it to zero would slide the page
 * down instead of clipping it.
 */
export function validateBrowserLayout(raw: unknown): BrowserLayoutRequest {
  const request = requireRequest(raw);
  const bounds = requireObject(request['bounds'], 'bounds');
  const at = (field: string, min: number): number =>
    requireFiniteNumber(bounds[field], `bounds.${field}`, min, LIMITS.coordinate);

  return {
    id: requireId(request['id'], 'id'),
    bounds: {
      x: at('x', -LIMITS.coordinate),
      y: at('y', -LIMITS.coordinate),
      width: at('width', 0),
      height: at('height', 0),
    },
    visible: optionalBoolean(request['visible'], 'visible') ?? false,
  };
}

export function validateBrowserClose(raw: unknown): BrowserCloseRequest {
  const request = requireRequest(raw);
  return { id: requireId(request['id'], 'id') };
}

export function validateBrowserList(raw: unknown): BrowserListRequest {
  requireRequest(raw);
  return {};
}

const BROWSER_COMMANDS = new Set(['back', 'forward', 'reload', 'stop']);

/* -------------------------------------------------------------------------- */
/* Terminals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Bytes on their way into a shell.
 *
 * Deliberately **not** {@link requireString}, and the two differences are both
 * the point:
 *
 *  - **NUL is legal here.** `requireString` rejects `\0` because everywhere
 *    else in this file a NUL is a truncation attack on something that will
 *    become a path or a record. In a terminal it is `Ctrl-@`, a key people
 *    genuinely press — it is how you set the mark in Emacs and readline — and
 *    refusing it would break a keyboard shortcut to defend a string that is
 *    never parsed as anything.
 *  - **Empty is legal here.** A write with nothing in it is a no-op, not a
 *    malformed request, and failing it would only mean the renderer having to
 *    know not to send one.
 *
 * What is left is a length bound, which is the only thing this can usefully
 * check: every byte after it goes to a shell's stdin, and a shell's stdin
 * accepts anything.
 */
function requireTerminalData(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(field, 'must be a string');
  if (value.length > LIMITS.terminalData) {
    throw new ValidationError(field, `must be at most ${LIMITS.terminalData} characters`);
  }
  return value;
}

/**
 * Open a shell.
 *
 * The only terminal request that names a *place*, and so the only one that
 * needs a path checked. Every other one names a terminal by an id the main
 * process issued — see `main/terminal.ts` — which is why they are three lines
 * each.
 *
 * `cwd` is checked for shape here and for existence in the handler, by the same
 * `checkWorkingDirectory` a run start uses. Splitting it that way is not
 * ceremony: this layer is synchronous and pure, and "is there a directory
 * there" is neither.
 */
export function validateTerminalStart(raw: unknown): TerminalStartRequest {
  const request = requireRequest(raw);
  return {
    cwd: requireAbsolutePath(request['cwd'], 'cwd'),
    cols: requireInteger(request['cols'], 'cols', 1, LIMITS.terminalDimension),
    rows: requireInteger(request['rows'], 'rows', 1, LIMITS.terminalDimension),
  };
}

export function validateTerminalWrite(raw: unknown): TerminalWriteRequest {
  const request = requireRequest(raw);
  return {
    id: requireId(request['id'], 'id'),
    data: requireTerminalData(request['data'], 'data'),
  };
}

export function validateTerminalResize(raw: unknown): TerminalResizeRequest {
  const request = requireRequest(raw);
  return {
    id: requireId(request['id'], 'id'),
    cols: requireInteger(request['cols'], 'cols', 1, LIMITS.terminalDimension),
    rows: requireInteger(request['rows'], 'rows', 1, LIMITS.terminalDimension),
  };
}

export function validateTerminalClose(raw: unknown): TerminalCloseRequest {
  return { id: requireId(requireRequest(raw)['id'], 'id') };
}

export function validateTerminalList(raw: unknown): TerminalListRequest {
  requireRequest(raw);
  return {};
}

export function validateTerminalReplay(raw: unknown): TerminalReplayRequest {
  return { id: requireId(requireRequest(raw)['id'], 'id') };
}

/** Opening a stored session: which profile, which session, which run to stamp. */
export function validateSessionsMessages(raw: unknown): SessionsMessagesRequest {
  const request = requireRequest(raw);
  return compact<SessionsMessagesRequest>({
    profileId: requireId(request['profileId'], 'profileId'),
    sessionId: requireId(request['sessionId'], 'sessionId'),
    runId: requireId(request['runId'], 'runId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
    limit: optionalInteger(request['limit'], 'limit', 1, LIMITS.messagePage),
    offset: optionalInteger(request['offset'], 'offset', 0, LIMITS.offset),
  });
}

/**
 * Opening one subagent's conversation.
 *
 * `agentId` goes through {@link requireId} for a reason worth stating: the
 * provider resolves it into a *filename* (`subagents/agent-<id>.jsonl`), so it
 * is renderer-supplied input that reaches the filesystem. `ID_PATTERN` admits
 * no `/` and no leading `.`, which is what makes traversal out of the session's
 * own directory unexpressible rather than merely unlikely — the same guarantee
 * every other id on this seam already relies on.
 */
export function validateSessionsSubagentMessages(raw: unknown): SessionsSubagentMessagesRequest {
  const request = requireRequest(raw);
  return compact<SessionsSubagentMessagesRequest>({
    profileId: requireId(request['profileId'], 'profileId'),
    sessionId: requireId(request['sessionId'], 'sessionId'),
    agentId: requireId(request['agentId'], 'agentId'),
    runId: requireId(request['runId'], 'runId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
    limit: optionalInteger(request['limit'], 'limit', 1, LIMITS.messagePage),
    offset: optionalInteger(request['offset'], 'offset', 0, LIMITS.offset),
  });
}

/**
 * Retitle one session.
 *
 * `title` is bounded but not otherwise policed: it is a display string that is
 * appended to a JSONL record and rendered as text, never interpolated into a
 * path or a command, so the only hostile input worth refusing here is one big
 * enough to be an attack on the store itself. `requireString` already rejects
 * NUL bytes, which is the character that would corrupt the record.
 */
export function validateSessionsRename(raw: unknown): SessionsRenameRequest {
  const request = requireRequest(raw);
  return compact<SessionsRenameRequest>({
    profileId: requireId(request['profileId'], 'profileId'),
    sessionId: requireId(request['sessionId'], 'sessionId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
    title: requireString(request['title'], 'title', LIMITS.sessionTitle),
  });
}

/**
 * Destroy one session.
 *
 * Nothing here is a policy check. The decision to delete is the user's and was
 * taken in front of a confirmation dialog in the renderer; this only makes sure
 * the three fields naming *which* transcript are well-formed, so that a
 * malformed id cannot become a path.
 */
export function validateSessionsDelete(raw: unknown): SessionsDeleteRequest {
  const request = requireRequest(raw);
  return compact<SessionsDeleteRequest>({
    profileId: requireId(request['profileId'], 'profileId'),
    sessionId: requireId(request['sessionId'], 'sessionId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
  });
}

/**
 * The tag is passed through as an opaque string, or `null` to clear it.
 *
 * Bounded by `LIMITS.label` rather than free: it is written into the provider's
 * own store, where a caller that could send a megabyte would be writing that
 * megabyte into somebody else's file.
 */
export function validateSessionsTag(raw: unknown): SessionsTagRequest {
  const request = requireRequest(raw);
  const tag = request['tag'];
  return compact<SessionsTagRequest>({
    profileId: requireId(request['profileId'], 'profileId'),
    sessionId: requireId(request['sessionId'], 'sessionId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
    tag: tag === null ? null : requireString(tag, 'tag', LIMITS.label),
  });
}

/** Plan usage is per-account, so a profile id is the whole request. */
export function validateAuthStatus(raw: unknown): AuthStatusRequest {
  const request = requireRequest(raw);
  return { profileId: requireId(request['profileId'], 'profileId') };
}

export function validateAuthSignOut(raw: unknown): AuthSignOutRequest {
  const request = requireRequest(raw);
  return { profileId: requireId(request['profileId'], 'profileId') };
}

/**
 * Accounts on a remote Artemis.
 *
 * `profileId` names the local Artemis-Server profile — which server — and
 * nothing here takes an address: the renderer has never been able to aim a
 * request at an arbitrary host, and this is not the surface that changes it.
 * `accountId` is the *serving* Artemis's own id for an account and is checked
 * as a string rather than as an id, because its shape is that server's business
 * and a stricter pattern here would refuse ids a future one mints.
 */
export function validateServerAccounts(raw: unknown): ServerAccountsRequest {
  const request = requireRequest(raw);
  return { profileId: requireId(request['profileId'], 'profileId') };
}

export function validateServerAccountsCreate(raw: unknown): ServerAccountsCreateRequest {
  const request = requireRequest(raw);
  const provider = request['provider'];
  if (provider !== undefined && provider !== null && !isProviderId(provider)) {
    throw new ValidationError('provider', 'is not a known provider');
  }
  return {
    profileId: requireId(request['profileId'], 'profileId'),
    label: requireString(request['label'], 'label', LIMITS.label),
    ...(provider === undefined || provider === null ? {} : { provider }),
  };
}

export function validateServerAccountsUpdate(raw: unknown): ServerAccountsUpdateRequest {
  const request = requireRequest(raw);
  const patch: { label?: string; baseUrl?: string; apiKey?: string } = {};
  if (request['label'] !== undefined) {
    patch.label = requireString(request['label'], 'label', LIMITS.label);
  }
  // Both accept the empty string: that is `ProfilePatch`'s own way to say
  // "back to absent", and refusing it here would leave no way to clear a key.
  if (request['baseUrl'] !== undefined) {
    const baseUrl = request['baseUrl'];
    if (typeof baseUrl !== 'string' || baseUrl.length > LIMITS.url) {
      throw new ValidationError('baseUrl', 'must be a string');
    }
    patch.baseUrl = baseUrl;
  }
  if (request['apiKey'] !== undefined) {
    const apiKey = request['apiKey'];
    if (typeof apiKey !== 'string' || apiKey.length > LIMITS.secret) {
      throw new ValidationError('apiKey', 'must be a string');
    }
    patch.apiKey = apiKey;
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('patch', 'names no field to change');
  }
  return {
    profileId: requireId(request['profileId'], 'profileId'),
    accountId: requireString(request['accountId'], 'accountId', LIMITS.id),
    ...patch,
  };
}

export function validateServerAccountsDelete(raw: unknown): ServerAccountsDeleteRequest {
  const request = requireRequest(raw);
  return {
    profileId: requireId(request['profileId'], 'profileId'),
    accountId: requireString(request['accountId'], 'accountId', LIMITS.id),
  };
}

export function validateServerAccountSignIn(raw: unknown): ServerAccountSignInRequest {
  const request = requireRequest(raw);
  return {
    profileId: requireId(request['profileId'], 'profileId'),
    accountId: requireString(request['accountId'], 'accountId', LIMITS.id),
  };
}

export function validateServerAccountSubmitCode(raw: unknown): ServerAccountSubmitCodeRequest {
  const request = requireRequest(raw);
  return {
    profileId: requireId(request['profileId'], 'profileId'),
    accountId: requireString(request['accountId'], 'accountId', LIMITS.id),
    // Capped like a label rather than like free text. This is a code a person
    // pasted from a browser; anything the size of a document is a paste that
    // went wrong, and the cap keeps a mistake from reaching a subprocess's
    // stdin.
    code: requireString(request['code'], 'code', LIMITS.label),
  };
}

export function validateUsagePlan(raw: unknown): UsagePlanRequest {
  const request = requireRequest(raw);
  return {
    profileId: requireId(request['profileId'], 'profileId'),
  };
}

/**
 * Every window channel's request: nothing at all.
 *
 * Shared by all four rather than written out four times, because there is
 * genuinely one shape and a copy per channel would only invite them to drift.
 *
 * `requireRequest` still runs, so a non-object payload is rejected rather than
 * ignored, and rule (2) at the top of this file still holds in the strongest
 * possible form — the returned object is a fresh empty one, so a renderer that
 * attaches a `windowId` finds it dropped before any handler could read it. That
 * is the point: the window a command acts on is the one it arrived from, and
 * nothing in the payload can change that.
 */
export function validateWindowRequest(raw: unknown): WindowRequest {
  requireRequest(raw);
  return {};
}

/**
 * The two parameterless update requests, held to the same standard as
 * {@link validateWindowRequest} and shaped the same way for the same reason:
 * a fresh empty object, so nothing a renderer attaches survives into a
 * handler. There is one updater and it is not addressable.
 */
export function validateUpdatesState(raw: unknown): UpdatesStateRequest {
  requireRequest(raw);
  return {};
}

/** @see validateUpdatesState */
export function validateUpdatesInstall(raw: unknown): UpdatesInstallRequest {
  requireRequest(raw);
  return {};
}

/** @see validateUpdatesState */
export function validateUpdatesRestart(raw: unknown): UpdatesRestartRequest {
  requireRequest(raw);
  return {};
}

/**
 * Checking is parameterless for the same reason the rest are, and the emptiness
 * is doing more work here than elsewhere: a check is the one update command that
 * reaches the network, and the only thing it could plausibly be asked to carry
 * is a feed to read. It carries nothing, so a renderer cannot aim one anywhere —
 * the channel and the URLs are settled in `updater.ts` and nothing in this
 * payload can move them.
 *
 * @see validateUpdatesState
 */
export function validateUpdatesCheck(raw: unknown): UpdatesCheckRequest {
  requireRequest(raw);
  return {};
}

/**
 * Dismissal names the version it silences — see {@link UpdatesDismissRequest}
 * for why "whatever is showing" would race. The string is bounded but not
 * pattern-checked: the updater compares it against the version it offered,
 * so an arbitrary value can only ever silence nothing.
 */
export function validateUpdatesDismiss(raw: unknown): UpdatesDismissRequest {
  const request = requireRequest(raw);
  return { version: requireString(request['version'], 'version', LIMITS.label) };
}

/**
 * The channel is a closed set of two, so it is checked against the set rather
 * than accepted as any string. An unrecognised value falls back to `stable`
 * rather than failing the call: the worst case for a bad value must be "you are
 * not offered prereleases", never "the app cannot start".
 */
export function validateUpdatesSetChannel(raw: unknown): UpdatesSetChannelRequest {
  const request = requireRequest(raw);
  return { channel: request['channel'] === 'beta' ? 'beta' : 'stable' };
}

/* -------------------------------------------------------------------------- */
/* Memory banks                                                               */
/* -------------------------------------------------------------------------- */

/** The banks' own slug rule, mirrored so a bad name fails here with a field error rather than as CLI stderr. */
const MEMORY_BANK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireBankSlug(value: unknown, field: string): string {
  const slug = requireString(value, field, 60);
  if (!MEMORY_BANK_SLUG_PATTERN.test(slug)) {
    throw new ValidationError(field, 'is not a valid bank slug');
  }
  return slug;
}

/**
 * The empty requests. Empty for the reason `SharedConfigStatusRequest` is:
 * main owns bank locations, so there is nothing safe for a renderer to say
 * here — see the memory-banks block in `protocol/src/ipc.ts`.
 */
export function validateMemoryBanksStatus(raw: unknown): MemoryBanksStatusRequest {
  requireRequest(raw);
  return {};
}

/** @see validateMemoryBanksStatus */
export function validateMemoryBanksPreflight(raw: unknown): MemoryBanksPreflightRequest {
  requireRequest(raw);
  return {};
}

/** One bank's memories; the slug must name a configured bank (the CLI checks). */
export function validateMemoryBankMemories(raw: unknown): MemoryBankMemoriesRequest {
  const request = requireRequest(raw);
  return { slug: requireBankSlug(request['slug'], 'slug') };
}

/**
 * The longest an access token may be.
 *
 * Generous — a GitHub fine-grained token is ~93 characters, a GitLab one 26,
 * and a JWT-shaped forge token can run to several hundred — and a cap all the
 * same, because this is the one field on this surface whose contents are never
 * looked at. Something kilobytes long is a paste accident or a probe, and
 * neither should reach a subprocess environment.
 */
const MEMORY_BANK_TOKEN_MAX = 4096;

/**
 * A bank's remote, refused for the two things it must never be.
 *
 * The shape rules live in `gitCredentialEnv.ts` next to the code that has to
 * honour them — chiefly that a remote may not carry credentials, the same rule
 * `optionalBaseUrl` applies to a local server's address and for the same
 * reason: a secret in this field would be written into `.git/config` on clone
 * and echoed by the banks' own plain-JSON registry.
 */
function requireBankRemote(value: unknown, field: string): string {
  const remote = requireString(value, field, 500);
  const problem = gitRemoteProblem(remote);
  if (problem !== null) throw new ValidationError(field, problem);
  return remote;
}

/**
 * The optional git credential, rebuilt field by field.
 *
 * Rebuilt rather than passed through — the rule everywhere on this boundary,
 * and the one place it matters most. This object is about to become the
 * environment of a subprocess, and an unknown key surviving validation is an
 * unknown key reaching a spawn.
 *
 * The token is not trimmed, for `optionalApiKey`'s reason: a token is whatever
 * the host issued, and quietly removing whitespace from a secret is how a
 * value that looks right fails to authenticate. The username is, because it is
 * a name a person typed and a trailing space in it is never meant.
 *
 * **Exactly one of `token` and `ref`.** Both is two answers to one question,
 * and whichever this function happened to prefer would be a silent decision
 * about where the user's secret lives. Neither is an `auth` that authenticates
 * as nobody, which the pane already avoids by omitting the field entirely.
 */
function optionalBankAuth(value: unknown, field: string): MemoryBankAuthInput | undefined {
  if (value === undefined || value === null) return undefined;
  const auth = requireObject(value, field);

  const hasToken = auth['token'] !== undefined && auth['token'] !== null;
  const hasRef = auth['ref'] !== undefined && auth['ref'] !== null;
  if (hasToken && hasRef) {
    throw new ValidationError(field, 'must carry a token or a secret reference, not both');
  }
  if (!hasToken && !hasRef) {
    throw new ValidationError(field, 'must carry either a token or a secret reference');
  }

  const rawUsername = optionalString(auth['username'], `${field}.username`, 64);
  let username: string | undefined;
  if (rawUsername !== undefined) {
    username = rawUsername.trim();
    const problem = gitCredentialUsernameProblem(username);
    if (problem !== null) throw new ValidationError(`${field}.username`, problem);
  }

  if (hasRef) {
    const ref = requireSecretRef(auth['ref'], `${field}.ref`);
    return username === undefined ? { ref } : { ref, username };
  }
  const token = requireString(auth['token'], `${field}.token`, MEMORY_BANK_TOKEN_MAX);
  return username === undefined ? { token } : { token, username };
}

/**
 * Registration is the one channel that names locations, so it is the one
 * validated hardest: a mode from the closed set, a slug in the banks' own
 * grammar, a role from the closed set — and the remote/path length-capped.
 * What the strings *mean* is the CLI's to judge (it refuses non-banks,
 * unreadable remotes, and slug collisions in its own words).
 *
 * It is now also the one channel that carries a secret, which is why the
 * remote gained a shape check: `auth.token` and a credential-bearing URL are
 * two ways to say the same thing, and only one of them keeps the secret out of
 * the clone's config file.
 */
export function validateMemoryBankAdd(raw: unknown): MemoryBankAddRequest {
  const request = requireRequest(raw);
  const mode = requireString(request['mode'], 'mode', 10);
  if (mode !== 'join' && mode !== 'create' && mode !== 'adopt') {
    throw new ValidationError('mode', 'must be "join", "create" or "adopt"');
  }
  const slug = requireBankSlug(request['slug'], 'slug');
  const role = requireString(request['role'], 'role', 10);
  if (role !== 'readwrite' && role !== 'readonly') {
    throw new ValidationError('role', 'must be "readwrite" or "readonly"');
  }
  const remote =
    request['remote'] === undefined || request['remote'] === null
      ? undefined
      : requireBankRemote(request['remote'], 'remote');
  if (mode === 'join' && (remote === undefined || remote.length === 0)) {
    throw new ValidationError('remote', 'is required to join a bank');
  }
  const path = optionalString(request['path'], 'path', 1000);
  if (mode === 'adopt' && (path === undefined || path.length === 0)) {
    throw new ValidationError('path', 'is required to adopt a bank');
  }
  const auth = optionalBankAuth(request['auth'], 'auth');
  return {
    mode,
    slug,
    role,
    ...(remote === undefined ? {} : { remote }),
    ...(path === undefined ? {} : { path }),
    ...(auth === undefined ? {} : { auth }),
  };
}

/**
 * Ask whether a remote is readable. The only channel here that names a remote
 * without joining it, and the only one that may be called with a token the
 * user has not committed to storing.
 */
export function validateMemoryBanksVerifyRemote(raw: unknown): MemoryBankVerifyRemoteRequest {
  const request = requireRequest(raw);
  const remote = requireBankRemote(request['remote'], 'remote');
  const auth = optionalBankAuth(request['auth'], 'auth');
  return { remote, ...(auth === undefined ? {} : { auth }) };
}

/** Sync one bank, or all when the slug is omitted. */
export function validateMemoryBankSync(raw: unknown): MemoryBankSyncRequest {
  const request = requireRequest(raw);
  const slug = request['slug'] === undefined ? undefined : requireBankSlug(request['slug'], 'slug');
  return slug === undefined ? {} : { slug };
}

/** Retirement names a slug; the CLI answers "no memory named …" for one that does not exist. */
export function validateMemoryBankRetire(raw: unknown): MemoryBankRetireRequest {
  const request = requireRequest(raw);
  const slug = requireBankSlug(request['slug'], 'slug');
  const name = requireString(request['name'], 'name', 60);
  if (!MEMORY_BANK_SLUG_PATTERN.test(name)) {
    throw new ValidationError('name', 'is not a valid memory slug');
  }
  const reason = optionalString(request['reason'], 'reason', 200);
  return { slug, name, ...(reason === undefined ? {} : { reason }) };
}

/**
 * Per-bank wiring, as a state rather than a toggle.
 *
 * Required rather than defaulted: a missing field defaulting to `true` would
 * let a malformed call opt the machine into writing to a shared repository,
 * and defaulting to `false` would silently undo an opt-in. Neither is a
 * decision this layer gets to make on the user's behalf.
 */
export function validateMemoryBankSetEnabled(raw: unknown): MemoryBankSetEnabledRequest {
  const request = requireRequest(raw);
  const slug = requireBankSlug(request['slug'], 'slug');
  const enabled = optionalBoolean(request['enabled'], 'enabled');
  if (enabled === undefined) throw new ValidationError('enabled', 'is required');
  return { slug, enabled };
}

/** Forgetting names a bank; everything else is main's. */
export function validateMemoryBankForget(raw: unknown): MemoryBankForgetRequest {
  const request = requireRequest(raw);
  return { slug: requireBankSlug(request['slug'], 'slug') };
}

/** The master gate, strict for `validateMemoryBankSetEnabled`'s reason. */
export function validateMemoryBanksSetMasterEnabled(raw: unknown): MemoryBanksSetMasterEnabledRequest {
  const request = requireRequest(raw);
  const enabled = optionalBoolean(request['enabled'], 'enabled');
  if (enabled === undefined) throw new ValidationError('enabled', 'is required');
  return { enabled };
}

/* -------------------------------------------------------------------------- */
/* Key managers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The longest a manager credential may be.
 *
 * The same argument as `MEMORY_BANK_TOKEN_MAX`, and a different number because
 * the values differ: an OpenBao service token is ~95 characters, a Doppler one
 * ~44, and a JWT-shaped one from a future auth method can run long. Anything
 * kilobyte-sized is a paste accident or a probe.
 */
const SECRET_CREDENTIAL_MAX = 8192;

/** A PEM chain is a few kilobytes; a megabyte of one is not a certificate. */
const SECRET_CA_PEM_MAX = 64 * 1024;

/**
 * A reference, rebuilt field by field against the protocol's own grammar.
 *
 * Two checks and both are load-bearing. The rebuild is the house rule, sharper
 * than usual here because every string below is interpolated into a URL path
 * or query on its way to a key manager — a smuggled extra key would be a
 * smuggled request parameter. And `secretRefProblem` is the *shared* grammar:
 * the renderer disables its Test button with the same function, so a reference
 * the pane thinks is fine cannot be one main refuses, and a `..` segment is
 * refused in exactly one place rather than in two that drift.
 */
function requireSecretRef(value: unknown, field: string): SecretRef {
  const raw = requireObject(value, field);
  const connectionId = requireString(raw['connectionId'], `${field}.connectionId`, 100);
  const provider = raw['provider'];

  let ref: SecretRef;
  if (provider === 'openbao') {
    const kvVersion = raw['kvVersion'];
    if (
      kvVersion !== undefined &&
      kvVersion !== null &&
      kvVersion !== 1 &&
      kvVersion !== 2 &&
      kvVersion !== 'auto'
    ) {
      throw new ValidationError(`${field}.kvVersion`, 'must be 1, 2 or "auto"');
    }
    ref = {
      provider: 'openbao',
      connectionId,
      mount: requireString(raw['mount'], `${field}.mount`, 500),
      path: requireString(raw['path'], `${field}.path`, 500),
      key: requireString(raw['key'], `${field}.key`, 300),
      ...(kvVersion === undefined || kvVersion === null ? {} : { kvVersion }),
    };
  } else if (provider === 'doppler') {
    const project = optionalString(raw['project'], `${field}.project`, 300);
    const config = optionalString(raw['config'], `${field}.config`, 300);
    ref = {
      provider: 'doppler',
      connectionId,
      name: requireString(raw['name'], `${field}.name`, 300),
      ...(project === undefined ? {} : { project }),
      ...(config === undefined ? {} : { config }),
    };
  } else {
    throw new ValidationError(`${field}.provider`, 'must be "openbao" or "doppler"');
  }

  const problem = secretRefProblem(ref);
  if (problem !== null) throw new ValidationError(field, problem);
  return ref;
}

/** Empty; main owns the registry's location. @see validateMemoryBanksStatus */
export function validateSecretsConnectionsList(raw: unknown): SecretsConnectionsListRequest {
  requireRequest(raw);
  return {};
}

/**
 * The one channel on this surface that carries a credential.
 *
 * Validated hardest for that reason, and rebuilt for the usual one — the
 * result becomes a record on disk and, for `userpass`, the body of a login
 * request. The credential itself is length-capped and otherwise untouched:
 * trimming a secret is how a value that looks right fails to authenticate.
 */
export function validateSecretsConnectionSave(raw: unknown): SecretsConnectionSaveRequest {
  const request = requireRequest(raw);
  const id = optionalString(request['id'], 'id', 100);
  const label = requireString(request['label'], 'label', 100).trim();
  if (label.length === 0) throw new ValidationError('label', 'must not be empty');

  const provider = request['provider'];
  if (provider !== 'openbao' && provider !== 'doppler') {
    throw new ValidationError('provider', 'must be "openbao" or "doppler"');
  }
  const authMethod = request['authMethod'];
  if (authMethod !== 'userpass' && authMethod !== 'token') {
    throw new ValidationError('authMethod', 'must be "userpass" or "token"');
  }

  // The address goes through the same check a local server's does, which
  // refuses a credential embedded in the URL — a manager address carrying
  // `user:pass@` would put a secret in a plain JSON file this feature exists
  // to keep secrets out of. An empty address is allowed here and defaulted in
  // main, because Doppler's is fixed and the form does not ask for it.
  //
  // Read with `typeof` rather than through `optionalString`, which refuses an
  // empty string outright — and an empty string is precisely what the pane
  // sends for a provider whose address field it does not render. Treating
  // "" and absent alike is what makes "leave it blank" mean what it says.
  const rawAddress = request['address'];
  if (rawAddress !== undefined && rawAddress !== null && typeof rawAddress !== 'string') {
    throw new ValidationError('address', 'must be a string');
  }
  if (typeof rawAddress === 'string' && rawAddress.length > 500) {
    throw new ValidationError('address', 'must be at most 500 characters');
  }
  const address = typeof rawAddress === 'string' ? rawAddress.trim() : '';
  if (address.length > 0) {
    const problem = baseUrlProblem(address);
    if (problem !== null) throw new ValidationError('address', problem);
  } else if (provider !== 'doppler') {
    throw new ValidationError('address', 'is required');
  }

  const caPem = optionalString(request['caPem'], 'caPem', SECRET_CA_PEM_MAX);
  if (caPem !== undefined && !caPem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new ValidationError('caPem', 'is not a PEM certificate');
  }
  const rawUsername = optionalString(request['username'], 'username', 200);
  const username = rawUsername === undefined ? undefined : rawUsername.trim();
  if (authMethod === 'userpass' && (username === undefined || username.length === 0)) {
    throw new ValidationError('username', 'is required for a username and password login');
  }

  let credential: SecretCredentialInput | undefined;
  if (request['credential'] !== undefined && request['credential'] !== null) {
    const rawCredential = requireObject(request['credential'], 'credential');
    const password = optionalString(rawCredential['password'], 'credential.password', SECRET_CREDENTIAL_MAX);
    const token = optionalString(rawCredential['token'], 'credential.token', SECRET_CREDENTIAL_MAX);
    if (password !== undefined && token !== undefined) {
      throw new ValidationError('credential', 'must carry a password or a token, not both');
    }
    if (password !== undefined || token !== undefined) {
      credential = {
        ...(password === undefined ? {} : { password }),
        ...(token === undefined ? {} : { token }),
      };
    }
  }

  return {
    ...(id === undefined ? {} : { id }),
    label,
    provider,
    address,
    ...(caPem === undefined ? {} : { caPem }),
    authMethod,
    ...(username === undefined || username.length === 0 ? {} : { username }),
    ...(credential === undefined ? {} : { credential }),
  };
}

/** Names a connection; main answers "there is no connection with that id". */
export function validateSecretsConnectionDelete(raw: unknown): SecretsConnectionDeleteRequest {
  const request = requireRequest(raw);
  return { id: requireString(request['id'], 'id', 100) };
}

/** @see validateSecretsConnectionDelete */
export function validateSecretsConnectionVerify(raw: unknown): SecretsConnectionVerifyRequest {
  const request = requireRequest(raw);
  return { id: requireString(request['id'], 'id', 100) };
}

/**
 * An address to shake hands with.
 *
 * The one channel here that names a host without a connection existing — the
 * moment it is needed is the moment the connection does not verify yet. Same
 * URL rules all the same: a renderer cannot use this to open a socket to an
 * address the address validator would refuse.
 */
export function validateSecretsFetchServerCert(raw: unknown): SecretsFetchServerCertRequest {
  const request = requireRequest(raw);
  const address = requireString(request['address'], 'address', 500).trim();
  const problem = baseUrlProblem(address);
  if (problem !== null) throw new ValidationError('address', problem);
  return { address };
}

/** A reference to resolve and throw away. @see requireSecretRef */
export function validateSecretsRefTest(raw: unknown): SecretsRefTestRequest {
  const request = requireRequest(raw);
  return { ref: requireSecretRef(request['ref'], 'ref') };
}

/* -------------------------------------------------------------------------- */
/* Agent prompts                                                              */
/* -------------------------------------------------------------------------- */

/** Empty; main owns the library's location. @see validateMemoryBanksStatus */
export function validateAgentPromptsList(raw: unknown): AgentPromptsListRequest {
  requireRequest(raw);
  return {};
}

function validateAgentPromptScope(value: unknown, field: string): AgentPromptScope {
  const scope = requireObject(value, field);
  const kind = requireString(scope['kind'], `${field}.kind`, 20);
  if (kind === 'all') return { kind: 'all' };
  if (kind !== 'profiles') {
    throw new ValidationError(`${field}.kind`, 'must be "all" or "profiles"');
  }
  return {
    kind: 'profiles',
    profileIds:
      optionalStringArray(
        scope['profileIds'],
        `${field}.profileIds`,
        LIMITS.promptScopeProfiles,
        LIMITS.id,
      ) ?? [],
  };
}

function validateAgentPrompt(value: unknown, field: string): AgentPrompt {
  const prompt = requireObject(value, field);
  const id = requireId(prompt['id'], `${field}.id`);

  const rawBuiltIn = optionalString(prompt['builtIn'], `${field}.builtIn`, 200);
  if (rawBuiltIn !== undefined && !isBuiltInPromptId(rawBuiltIn)) {
    throw new ValidationError(`${field}.builtIn`, `names no prompt this build ships`);
  }
  const builtIn = rawBuiltIn as BuiltInPromptId | undefined;
  // The flag the renderer sets when the user edits a built-in's text, and the
  // one thing that makes a body for one legitimate. Only meaningful on a
  // built-in: on a prompt the user wrote there is nothing to override.
  const overridden =
    builtIn !== undefined && (optionalBoolean(prompt['overridden'], `${field}.overridden`) ?? false);

  return {
    id,
    name: requireString(prompt['name'], `${field}.name`, AGENT_PROMPT_LIMITS.name),
    // Not merely allowed to be empty for a built-in the user has left alone —
    // required to be. Its text ships with Artemis, and accepting a body without
    // the override flag would let a renderer put words into a prompt the pane
    // presents as Artemis's own.
    markdown: builtIn === undefined || overridden
      ? optionalString(prompt['markdown'], `${field}.markdown`, AGENT_PROMPT_LIMITS.markdown) ?? ''
      : '',
    enabled: optionalBoolean(prompt['enabled'], `${field}.enabled`) ?? true,
    scope: validateAgentPromptScope(prompt['scope'], `${field}.scope`),
    ...(builtIn === undefined ? {} : { builtIn }),
    ...(overridden ? { overridden: true } : {}),
  };
}

/**
 * The whole library, rebuilt prompt by prompt.
 *
 * The count and length caps are the bounds from the protocol, enforced here so
 * a renderer cannot hand the main process an unbounded string to write to disk
 * — the one thing this channel does that costs something.
 */
export function validateAgentPromptsSave(raw: unknown): AgentPromptsSaveRequest {
  const request = requireRequest(raw);
  const document = requireObject(request['document'], 'document');

  const rawPrompts = document['prompts'];
  if (!Array.isArray(rawPrompts)) {
    throw new ValidationError('document.prompts', 'must be an array');
  }
  if (rawPrompts.length > AGENT_PROMPT_LIMITS.count) {
    throw new ValidationError(
      'document.prompts',
      `must hold at most ${AGENT_PROMPT_LIMITS.count} prompts`,
    );
  }

  // Built-ins the user removed. Bounded by how many Artemis ships — a list
  // longer than that cannot be describing this build's prompts — and each entry
  // has to name one, for the same reason `builtIn` on a row has to: a
  // dismissal for a prompt that does not exist is a hand-edit or a bug, and
  // storing it would let it shadow a prompt a later build ships under that id.
  const dismissed = optionalStringArray(
    document['dismissedBuiltIns'],
    'document.dismissedBuiltIns',
    BUILT_IN_PROMPT_IDS.length,
    200,
  );
  for (const [index, entry] of (dismissed ?? []).entries()) {
    if (!isBuiltInPromptId(entry)) {
      throw new ValidationError(
        `document.dismissedBuiltIns[${index}]`,
        'names no prompt this build ships',
      );
    }
  }

  return {
    document: {
      version: AGENT_PROMPTS_VERSION,
      prompts: rawPrompts.map((entry, index) =>
        validateAgentPrompt(entry, `document.prompts[${index}]`),
      ),
      ...(dismissed === undefined || dismissed.length === 0
        ? {}
        : { dismissedBuiltIns: dismissed as BuiltInPromptId[] }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The four empty server requests.
 *
 * Empty for `validateMemoryBanksStatus`'s reason, and with one addition of its own:
 * there is exactly one server, main owns its address, and the renderer decides
 * only whether it runs. Nothing here could name a profile, a model or a host
 * without handing the renderer a say in what gets published.
 */
export function validateServerStatus(raw: unknown): ServerStatusRequest {
  requireRequest(raw);
  return {};
}

/** @see validateServerStatus */
export function validateServerStart(raw: unknown): ServerStartRequest {
  requireRequest(raw);
  return {};
}

/** @see validateServerStatus */
export function validateServerStop(raw: unknown): ServerStopRequest {
  requireRequest(raw);
  return {};
}

/**
 * A connection to be issued: a label, and the workspace it is bound to.
 *
 * The workspace is validated strictly because it *is* the grant. A `directory`
 * must name an absolute path — a relative one would resolve against whatever
 * directory the app was launched from, which is not a decision the user made —
 * and an unrecognised kind is rejected rather than defaulted, because guessing
 * which authority someone meant to grant is the one thing this must never do.
 */
export function validateServerCreateConnection(raw: unknown): ServerCreateConnectionRequest {
  const request = requireRequest(raw);
  const label = requireString(request['label'], 'label', LIMITS.label);
  const workspace = requireObject(request['workspace'], 'workspace');
  const kind = requireString(workspace['kind'], 'workspace.kind', 20);

  let resolved: ServerWorkspace;
  if (kind === 'directory') {
    const path = requireString(workspace['path'], 'workspace.path', LIMITS.path);
    if (!path.startsWith('/')) {
      throw new ValidationError('workspace.path', 'must be an absolute path');
    }
    resolved = { kind: 'directory', path };
  } else if (kind === 'ephemeral') {
    resolved = normalizeWorkspace({
      kind: 'ephemeral',
      perSession: optionalBoolean(workspace['perSession'], 'workspace.perSession') !== false,
    });
  } else if (kind === 'none') {
    resolved = { kind: 'none' };
  } else {
    throw new ValidationError('workspace.kind', 'must be "directory", "ephemeral" or "none"');
  }

  const allow = validateAllowance(request['allow']);

  /*
   * An expiry instant, bounded above rather than merely typed.
   *
   * The ceiling is a century out, which no user will ever choose and which
   * catches the mistake that actually happens: seconds sent where milliseconds
   * were meant lands a token in 1970 and is dropped by the host as already
   * past, while milliseconds×1000 lands it past any clock and is refused here.
   * Neither is a token anybody meant to create.
   */
  const expiresAt = optionalInteger(
    request['expiresAt'],
    'expiresAt',
    0,
    Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
  );

  return {
    label,
    workspace: resolved,
    ...(allow === undefined || allow.length === 0 ? {} : { allow }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * The accounts and models a connection may reach.
 *
 * Ids, never routes — see `ServerAllowance` for why a slug is unsafe to hold a
 * permission on. Nothing here is checked against the *catalogue*: an id for an
 * account that does not exist grants nothing, and rejecting it would make the
 * form fail whenever a profile is deleted between opening it and submitting.
 */
function validateAllowance(value: unknown): ServerAllowance[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError('allow', 'must be an array');

  return value.map((raw, index) => {
    const entry = requireObject(raw, `allow[${index}]`);
    const profileId = requireString(entry['profileId'], `allow[${index}].profileId`, LIMITS.id);

    const rawModels = entry['modelIds'];
    if (rawModels !== undefined && rawModels !== null && !Array.isArray(rawModels)) {
      throw new ValidationError(`allow[${index}].modelIds`, 'must be an array');
    }
    const modelIds = Array.isArray(rawModels)
      ? rawModels.map((model, at) =>
          requireString(model, `allow[${index}].modelIds[${at}]`, LIMITS.label),
        )
      : undefined;

    return {
      profileId: profileId as ServerAllowance['profileId'],
      ...(modelIds === undefined || modelIds.length === 0 ? {} : { modelIds }),
    };
  });
}

/** @see validateServerCreateConnection */
export function validateServerRenameConnection(raw: unknown): ServerRenameConnectionRequest {
  const request = requireRequest(raw);
  return {
    id: requireString(request['id'], 'id', LIMITS.id),
    label: requireString(request['label'], 'label', LIMITS.label),
  };
}

/** @see validateServerCreateConnection */
export function validateServerDeleteConnection(raw: unknown): ServerDeleteConnectionRequest {
  const request = requireRequest(raw);
  return { id: requireString(request['id'], 'id', LIMITS.id) };
}

/**
 * A port and an autostart flag, each optional.
 *
 * `0` is accepted alongside the ordinary range because it is a real request —
 * "bind any free port" — which is why the bound port is reported separately on
 * the state. Both fields stay absent when they were absent: see
 * `ServerConfigureRequest` for why "leave it alone" has to be expressible.
 */
export function validateServerConfigure(raw: unknown): ServerConfigureRequest {
  const request = requireRequest(raw);
  const port = optionalInteger(request['port'], 'port', 0, MAX_SERVER_PORT);
  if (port !== undefined && !isValidServerPort(port)) {
    throw new ValidationError('port', `must be 0, or between ${MIN_SERVER_PORT} and ${MAX_SERVER_PORT}`);
  }
  const autoStart = optionalBoolean(request['autoStart'], 'autoStart');
  return {
    ...(port === undefined ? {} : { port }),
    ...(autoStart === undefined ? {} : { autoStart }),
  };
}

/**
 * A single optional flag, and the only server request that carries anything.
 *
 * `refresh` is expensive — it re-asks every provider's CLI — so it is checked
 * rather than coerced: a truthy string arriving here would mean a client
 * spawning subprocesses by accident.
 */
export function validateServerCatalogue(raw: unknown): ServerCatalogueRequest {
  const request = requireRequest(raw);
  const refresh = optionalBoolean(request['refresh'], 'refresh');
  return refresh === undefined ? {} : { refresh };
}

/* -------------------------------------------------------------------------- */
/* Remote access                                                              */
/* -------------------------------------------------------------------------- */

/** @see validateServerStatus */
export function validateRemoteStatus(raw: unknown): RemoteAccessStatusRequest {
  requireRequest(raw);
  return {};
}

/**
 * An origin string or an explicit null. Shape only — whether the string is an
 * acceptable origin is `normalizeRemoteOrigin`'s question, answered in the
 * handler so the refusal can carry a sentence rather than a validation error.
 */
export function validateRemoteConfigure(raw: unknown): RemoteAccessConfigureRequest {
  const request = requireRequest(raw);
  const origin = request['origin'];
  if (origin !== null && typeof origin !== 'string') {
    throw new ValidationError('origin', 'must be a string or null');
  }
  return { origin };
}

/* -------------------------------------------------------------------------- */
/* Routines                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Limits for the free-text fields a routine carries.
 *
 * Instructions get room — a routine's prompt is a real prompt — and the rest
 * are labels. Enforced here rather than trusted from the form, because the
 * file these end up in is read on every boot.
 */
const ROUTINE_NAME_MAX = 200;
const ROUTINE_INSTRUCTIONS_MAX = 20_000;

function requireSchedule(value: unknown, field: string) {
  const schedule = readSchedule(value);
  if (schedule === undefined) {
    throw new ValidationError(field, 'is not a usable schedule');
  }
  return schedule;
}

export function validateRoutinesList(raw: unknown): RoutinesListRequest {
  requireRequest(raw);
  return {};
}

export function validateRoutinesCreate(raw: unknown): RoutinesCreateRequest {
  const request = requireRequest(raw);
  const draft = requireObject(request['draft'], 'draft');

  const cwd = requireString(draft['cwd'], 'draft.cwd', 4_096);
  if (!isAbsolute(cwd)) throw new ValidationError('draft.cwd', 'must be an absolute path');

  const providerId = draft['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError('draft.providerId', 'is not a provider');

  const model = optionalString(draft['model'], 'draft.model', 200);
  const paused = optionalBoolean(draft['paused'], 'draft.paused');

  const built: RoutineDraft = {
    name: requireString(draft['name'], 'draft.name', ROUTINE_NAME_MAX),
    instructions: requireString(draft['instructions'], 'draft.instructions', ROUTINE_INSTRUCTIONS_MAX),
    cwd,
    profileId: requireString(draft['profileId'], 'draft.profileId', 200),
    providerId,
    ...(model === undefined ? {} : { model }),
    schedule: requireSchedule(draft['schedule'], 'draft.schedule'),
    ...(paused === undefined ? {} : { paused }),
  };
  return { draft: built };
}

export function validateRoutinesUpdate(raw: unknown): RoutinesUpdateRequest {
  const request = requireRequest(raw);
  const id = requireString(request['id'], 'id', 100);
  const patch = requireObject(request['patch'], 'patch');

  const cwd = optionalString(patch['cwd'], 'patch.cwd', 4_096);
  if (cwd !== undefined && !isAbsolute(cwd)) {
    throw new ValidationError('patch.cwd', 'must be an absolute path');
  }
  const providerId = patch['providerId'];
  if (providerId !== undefined && providerId !== null && !isProviderId(providerId)) {
    throw new ValidationError('patch.providerId', 'is not a provider');
  }
  const name = optionalString(patch['name'], 'patch.name', ROUTINE_NAME_MAX);
  const instructions = optionalString(
    patch['instructions'],
    'patch.instructions',
    ROUTINE_INSTRUCTIONS_MAX,
  );
  const profileId = optionalString(patch['profileId'], 'patch.profileId', 200);
  const paused = optionalBoolean(patch['paused'], 'patch.paused');

  /*
   * `model: ''` is the one empty string this file lets through: it is the
   * documented "clear the model" form, the same convention `ProfilePatch`
   * carries. `optionalString` refuses empties, so it is read by hand.
   */
  let model: string | undefined;
  if (patch['model'] !== undefined && patch['model'] !== null) {
    if (typeof patch['model'] !== 'string') {
      throw new ValidationError('patch.model', 'must be a string');
    }
    if (patch['model'].length > 200) {
      throw new ValidationError('patch.model', 'must be at most 200 characters');
    }
    model = patch['model'];
  }

  const built: RoutinePatch = {
    ...(name === undefined ? {} : { name }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(profileId === undefined ? {} : { profileId }),
    ...(providerId === undefined || providerId === null ? {} : { providerId }),
    ...(model === undefined ? {} : { model }),
    ...(patch['schedule'] === undefined || patch['schedule'] === null
      ? {}
      : { schedule: requireSchedule(patch['schedule'], 'patch.schedule') }),
    ...(paused === undefined ? {} : { paused }),
  };
  return { id, patch: built };
}

export function validateRoutinesDelete(raw: unknown): RoutinesDeleteRequest {
  const request = requireRequest(raw);
  return { id: requireString(request['id'], 'id', 100) };
}

/** @see validateRoutinesDelete */
export function validateRoutinesRunNow(raw: unknown): RoutinesRunNowRequest {
  const request = requireRequest(raw);
  return { id: requireString(request['id'], 'id', 100) };
}
