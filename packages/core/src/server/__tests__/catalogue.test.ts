import { describe, expect, it, vi } from 'vitest';

import type {
  ProfileId,
  ServerProfile,
  ProfileMetadata,
  ProviderDescriptor,
  ProviderModelOption,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { createCatalogue, type CatalogueSource } from '../catalogue.js';

const profile = (id: string, label: string, providerId = 'claude' as const): ProfileMetadata => ({
  id: id as ProfileId,
  label,
  providerId,
  configDir: `/tmp/${id}`,
});

const descriptor = (models: readonly ProviderModelOption[]): ProviderDescriptor => ({
  id: 'claude',
  kind: 'hosted',
  label: 'Claude',
  capabilities: NO_CAPABILITIES,
  models,
  effortLevels: [
    { id: 'low', label: 'Low', note: 'Fast.' },
    { id: 'high', label: 'High', note: 'Deep.' },
    { id: 'max', label: 'Max', note: 'Deepest.' },
  ],
  available: true,
});

function source(overrides: Partial<CatalogueSource> = {}): CatalogueSource {
  return {
    listProfiles: async () => [profile('a', 'Work Max')],
    listProviders: async () => [
      descriptor([
        {
          id: 'opus',
          label: 'Opus 5',
          note: 'The big one.',
          effortLevels: ['low', 'high'],
          supportsFastMode: true,
        },
      ]),
    ],
    listModels: async () => ({ models: [], live: false }),
    ...overrides,
  };
}

describe('createCatalogue', () => {
  it('routes every model under its account', async () => {
    const catalogue = createCatalogue({
      source: source({
        listModels: async () => ({
          models: [{ id: 'opus', label: 'Opus 5', note: 'The big one.' }],
          live: true,
        }),
      }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.slug).toBe('work-max');
    expect(entry?.models[0]?.route).toBe('work-max/opus');
    expect(entry?.live).toBe(true);
  });

  it('publishes only the thinking levels the model actually accepts', async () => {
    // The provider offers three; this model takes two. Publishing all three
    // would offer callers a level the run silently drops.
    const catalogue = createCatalogue({
      source: source({
        listModels: async () => ({
          models: [
            { id: 'opus', label: 'Opus 5', note: '.', effortLevels: ['low', 'high'] },
            { id: 'flat', label: 'Flat', note: '.', effortLevels: [] },
          ],
          live: true,
        }),
      }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.models[0]?.thinkingLevels.map((level) => level.id)).toEqual(['low', 'high']);
    // An empty array on the option means "no thinking setting at all", which is
    // not the same as an absent one.
    expect(entry?.models[1]?.thinkingLevels).toEqual([]);
  });

  it('turns absent capability flags into false rather than leaving them undefined', async () => {
    const catalogue = createCatalogue({
      source: source({
        listModels: async () => ({
          models: [
            { id: 'opus', label: 'Opus 5', note: '.', supportsFastMode: true },
            { id: 'plain', label: 'Plain', note: '.' },
          ],
          live: true,
        }),
      }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.models[0]).toMatchObject({ fastMode: true, ultracode: false });
    // A JSON consumer cannot tell a missing field from a false one, so the
    // distinction has to be closed here.
    expect(entry?.models[1]).toMatchObject({
      fastMode: false,
      ultracode: false,
      adaptiveThinking: false,
    });
  });

  it('serves a cached catalogue until it goes stale', async () => {
    const listModels = vi.fn(async () => ({ models: [], live: true }));
    let now = 1_000;
    const catalogue = createCatalogue({
      source: source({ listModels }),
      ttlMs: 60_000,
      now: () => now,
    });

    await catalogue.read();
    await catalogue.read();
    expect(listModels).toHaveBeenCalledTimes(1);

    now += 60_001;
    await catalogue.read();
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('re-reads on demand, and forgets when invalidated', async () => {
    const listModels = vi.fn(async () => ({ models: [], live: true }));
    const catalogue = createCatalogue({ source: source({ listModels }), now: () => 0 });

    await catalogue.read();
    await catalogue.read({ refresh: true });
    expect(listModels).toHaveBeenCalledTimes(2);

    catalogue.invalidate();
    await catalogue.read();
    expect(listModels).toHaveBeenCalledTimes(3);
  });

  it('builds once for callers that arrive together', async () => {
    // The single most important property in the file: each build spawns a
    // provider CLI per account, so N concurrent clients must not mean N builds.
    let builds = 0;
    const catalogue = createCatalogue({
      source: source({
        listModels: async () => {
          builds += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { models: [], live: true };
        },
      }),
    });

    await Promise.all([catalogue.read(), catalogue.read(), catalogue.read()]);
    expect(builds).toBe(1);
  });

  it('keeps one broken account from emptying the whole catalogue', async () => {
    const catalogue = createCatalogue({
      source: source({
        listProfiles: async () => [profile('a', 'Work'), profile('b', 'Home')],
        listModels: async ({ profileId }) => {
          if (profileId === ('a' as ProfileId)) throw new Error('the CLI exploded');
          return { models: [{ id: 'opus', label: 'Opus 5', note: '.' }], live: true };
        },
      }),
    });

    const profiles = await catalogue.read();
    expect(profiles).toHaveLength(2);
    // The failed one falls back to the descriptor's built-in list, unconfirmed.
    expect(profiles[0]?.live).toBe(false);
    expect(profiles[0]?.models[0]?.route).toBe('work/opus');
    expect(profiles[1]?.live).toBe(true);
  });

  it('keeps the built-in list when an unconfirmed answer comes back empty', async () => {
    // "Could not enumerate" is not "this account has no models". Taking the
    // empty answer would publish an account with no routes at all.
    const catalogue = createCatalogue({
      source: source({ listModels: async () => ({ models: [], live: false }) }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.models.map((model) => model.route)).toEqual(['work-max/opus']);
    expect(entry?.live).toBe(false);
  });

  it('takes a confirmed empty answer at its word', async () => {
    // The other direction: a local endpoint with nothing loaded really does
    // offer nothing, and publishing names it has never heard of would give
    // clients routes that cannot run.
    const catalogue = createCatalogue({
      source: source({ listModels: async () => ({ models: [], live: true }) }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.models).toEqual([]);
    expect(entry?.live).toBe(true);
  });

  it('describes an account whose provider this build cannot drive', async () => {
    const catalogue = createCatalogue({
      source: source({
        listProfiles: async () => [profile('a', 'Codex', 'codex')],
        listProviders: async () => [],
      }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.available).toBe(false);
    expect(entry?.unavailableReason).toMatch(/no adapter/i);
    expect(entry?.models).toEqual([]);
  });
});

describe('permission modes a host cannot honour', () => {
  const claudeCaps = {
    ...NO_CAPABILITIES,
    permissionModes: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
  } as unknown as ServerProfile['capabilities'];

  /** The two variables the CLI reads before refusing, cleared unless a case sets them. */
  const SANDBOX_KEYS = ['IS_SANDBOX', 'CLAUDE_CODE_BUBBLEWRAP'] as const;

  async function modesFor(
    providerId: string,
    uid: number | undefined,
    env: Partial<Record<(typeof SANDBOX_KEYS)[number], string>> = {},
  ) {
    const real = process.getuid;
    if (uid === undefined) {
      // Windows has no getuid, and the question does not arise there.
      delete (process as { getuid?: unknown }).getuid;
    } else {
      (process as { getuid?: () => number }).getuid = () => uid;
    }
    const realEnv = Object.fromEntries(SANDBOX_KEYS.map((key) => [key, process.env[key]]));
    for (const key of SANDBOX_KEYS) {
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      const catalogue = createCatalogue({
        source: {
          listProfiles: async () => [
            { id: 'p1', label: 'work', providerId, configDir: '/data/profiles/work' },
          ] as never,
          listProviders: async () =>
            [{ id: providerId, label: providerId, kind: 'hosted', available: true, capabilities: claudeCaps, models: [] }] as never,
          listModels: async () => ({ models: [], live: true }),
        },
      });
      const [profile] = await catalogue.read();
      return profile?.capabilities.permissionModes ?? [];
    } finally {
      if (real === undefined) delete (process as { getuid?: unknown }).getuid;
      else (process as { getuid?: () => number }).getuid = real;
      for (const key of SANDBOX_KEYS) {
        const value = realEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('drops bypassPermissions when the server runs as root', async () => {
    /*
     * Claude Code refuses `--dangerously-skip-permissions` outright under root
     * — "cannot be used with root/sudo privileges for security reasons", exit
     * 1 — and the containerised server runs as root. The mode was advertised,
     * chosen, sent, and then killed the run on spawn, with nothing upstream
     * able to know it never could have worked.
     */
    expect(await modesFor('claude', 0)).toEqual(['plan', 'default', 'acceptEdits']);
  });

  it('leaves every mode alone for an ordinary user', async () => {
    expect(await modesFor('claude', 1000)).toContain('bypassPermissions');
  });

  it('leaves every mode alone where there is no uid to read', async () => {
    // Windows. Absent must read as "not root" — the answer that changes nothing.
    expect(await modesFor('claude', undefined)).toContain('bypassPermissions');
  });

  it('does not touch a provider whose CLI has no such rule', async () => {
    // The refusal is Claude Code's, not a property of running as root.
    expect(await modesFor('codex', 0)).toContain('bypassPermissions');
  });

  it('keeps bypassPermissions under root when IS_SANDBOX=1 names the container as the sandbox', async () => {
    /*
     * The CLI's own opt-in: under root it accepts the flag when
     * `IS_SANDBOX=1`, which is how a container whose only user is root says
     * the sandbox is deliberate. A server started with it can serve the mode,
     * so the catalogue must offer it — withholding a mode that works is the
     * same lie as advertising one that does not, told the other way round.
     */
    expect(await modesFor('claude', 0, { IS_SANDBOX: '1' })).toContain('bypassPermissions');
  });

  it("keeps bypassPermissions under root inside the CLI's own bubblewrap", async () => {
    expect(await modesFor('claude', 0, { CLAUDE_CODE_BUBBLEWRAP: '1' })).toContain(
      'bypassPermissions',
    );
  });

  it('reads IS_SANDBOX the way the CLI does: only "1" counts', async () => {
    // `true`, `yes`, an empty string — the CLI compares against "1" and nothing
    // else, and a filter looser than the rule it mirrors would offer a mode
    // the spawn then kills.
    expect(await modesFor('claude', 0, { IS_SANDBOX: 'true' })).not.toContain('bypassPermissions');
    expect(await modesFor('claude', 0, { IS_SANDBOX: '' })).not.toContain('bypassPermissions');
    expect(await modesFor('claude', 0, { CLAUDE_CODE_BUBBLEWRAP: '' })).not.toContain(
      'bypassPermissions',
    );
  });
});
