/**
 * What the first frame opens as.
 *
 * `launch()` is the seam between the flags, the remembered preferences and
 * the settings a conversation starts with. It reads two files and spawns
 * nothing, so it can be driven against a temporary data directory holding
 * one account.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { launch, type Launched } from './launch.js';

const PROFILE_ID = 'prof_work';

let root: string;
let dataDir: string;
let stateDir: string;
let cacheDir: string;
let cwd: string;
const opened: Launched[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-launch-'));
  dataDir = join(root, 'data');
  stateDir = join(root, 'state');
  cacheDir = join(root, 'cache');
  cwd = join(root, 'work');
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(stateDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await writeFile(
    join(dataDir, 'profiles.json'),
    JSON.stringify({
      version: 2,
      profiles: [
        { id: PROFILE_ID, label: 'Work', providerId: 'claude', configDir: join(dataDir, 'profiles', 'work'), publicEnv: {}, createdAt: 1, updatedAt: 1 },
      ],
    }),
  );
});

afterEach(async () => {
  for (const launched of opened.splice(0)) await launched.host.dispose();
  await rm(root, { recursive: true, force: true });
});

async function open(extra: Record<string, unknown>): Promise<Launched> {
  const result = await launch({ dataDir, cwd, stateDir, cacheDir, profile: 'Work', ...extra });
  if (!result.ok) throw new Error(result.error);
  opened.push(result.launched);
  return result.launched;
}

async function remember(preferences: unknown): Promise<void> {
  await writeFile(join(stateDir, 'preferences.json'), JSON.stringify({ version: 1, preferences }));
}

describe('launch', () => {
  it('opens as the account it was last left as, when no account is named', async () => {
    // The order of preference the file describes, with the remembered
    // account first. Reaching the fallbacks would mean asking every account
    // for its conversations, which this test must not do.
    await remember({ profileId: PROFILE_ID });

    const result = await launch({ dataDir, cwd, stateDir, cacheDir });
    if (!result.ok) throw new Error(result.error);
    opened.push(result.launched);

    expect(result.launched.settings.profileId).toBe(PROFILE_ID);
  });

  it('restores the remembered permission mode only when the provider has it', async () => {
    await remember({ profileId: PROFILE_ID, permissionMode: 'plan' });
    expect((await open({})).settings.permissionMode).toBe('plan');

    // A mode the adapter would reject must not be handed to it; `default` is
    // the one every provider has.
    await remember({ profileId: PROFILE_ID, permissionMode: 'no-such-mode' });
    expect((await open({})).settings.permissionMode).toBe('default');
  });

  it('does not carry one model’s speed flags onto a different model named on the command line', async () => {
    // Fast mode belongs to the model it was chosen for. Remembered for model
    // `a`, it came along when `--model b` was given, and `b` may not even
    // have it.
    await remember({ profileId: PROFILE_ID, models: { [PROFILE_ID]: { model: 'a', fastMode: true, ultracode: true, effort: 'high' } } });

    const { settings } = await open({ model: 'b' });

    expect(settings.model).toBe('b');
    expect(settings.fastMode).toBeUndefined();
    expect(settings.ultracode).toBeUndefined();
    expect(settings.effort).toBeUndefined();
  });
});
