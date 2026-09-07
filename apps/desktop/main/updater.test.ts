/**
 * The updater's testable seams.
 *
 * The swap itself — two renames over /Applications — is exercised by release
 * builds, not by this file. What lives here are the pieces that were moved to
 * module scope precisely so they could be pinned:
 *
 *  - `fetchAnonymously` must give up on a server that stalls, whether it
 *    stalls before the headers or drips after them. Before it had a deadline,
 *    a slow-drip feed held `checking` set until relaunch, with the menu item
 *    greyed out for the duration.
 *  - `fetchAsset` must reduce a feed-controlled `path` to a bare filename
 *    before it becomes a local one, so `path: ../../x.zip` cannot write
 *    outside the staging directory.
 *  - `sha512Of` must produce the same digest streaming that `readFile` did in
 *    one piece.
 *  - `dismiss` must persist only a version that is actually on offer — the
 *    renderer-supplied string used to be written down unconditionally, which
 *    let a compromised renderer pre-silence a release nobody had seen.
 *  - a manual check must *re-read* the feed over an offer already on screen,
 *    and `feedToInstall` must let a newer release supersede one. An offer used
 *    to be final: a machine that saw 1.10.1 kept being handed 1.10.1 after
 *    1.11.0 shipped, because both the menu's check and the install trusted the
 *    version they already had.
 *  - `removeTree` must remove a tree on the platform running the suite. It
 *    shelled out to a hardcoded `/bin/rm`, so on Windows it rejected on every
 *    call, and the `finally` that ran it turned a check that had read the feed
 *    into one reporting it unreachable — for three releases, because the cases
 *    below that drive a real check were skipped off macOS.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UpdateProgress } from '@rx-artemis/protocol';

import type { UpdateFeed } from './updateFeed.js';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.1.0',
    relaunch: vi.fn(),
    quit: vi.fn(),
  },
}));

const {
  artifactExtension,
  createUpdater,
  feedName,
  forgetPacmanOwnership,
  ownedByPacman,
  feedToInstall,
  fetchAnonymously,
  fetchAsset,
  removeTree,
  sha512Of,
  throttleProgress,
} = await import('./updater');

const servers: Server[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** A local HTTP server whose whole personality is its request handler. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

function stubFetchWith(body: string): void {
  vi.stubGlobal('fetch', (() => Promise.resolve(new Response(body))) as typeof fetch);
}

/** The staging directories a check makes, and is supposed to take away again. */
function leftoverCheckDirs(): string[] {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith('artemis-update-check-'));
}

describe('removeTree', () => {
  it('removes a populated tree on the platform it is running on', async () => {
    // `/bin/rm` was unconditional through 2.4.2, so on Windows this rejected
    // with ENOENT for a path that plainly exists — and the updater awaited it
    // in a `finally`, which is how a check that had read the feed came back
    // saying the feed could not be reached.
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-remove-'));
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'artifact.bin'), randomBytes(32));

    await expect(removeTree(dir)).resolves.toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('treats an absent path as already removed', async () => {
    // The `-f` half of `-rf`, which the callers rely on: two of the three run
    // in a `finally` that can be reached before the directory was ever made.
    const gone = join(tmpdir(), `artemis-test-absent-${randomBytes(8).toString('hex')}`);

    await expect(removeTree(gone)).resolves.toBeUndefined();
  });
});

describe('fetchAnonymously', () => {
  it('gives up on a server that accepts the connection and never answers', async () => {
    const origin = await serve(() => {
      // Never respond: the connection sits open with no headers.
    });
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-fetch-'));
    await expect(
      fetchAnonymously(`${origin}/feed.yml`, join(dir, 'feed.yml'), 200),
    ).rejects.toThrow(/timeout|abort/i);
  });

  it('gives up on a slow drip — headers, one byte, then silence', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write('a');
      // ...and nothing more, ever. This is the shape of the failure the
      // deadline exists for: `fetch` has resolved, the body never ends.
    });
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-fetch-'));
    await expect(
      fetchAnonymously(`${origin}/big.zip`, join(dir, 'big.zip'), 200),
    ).rejects.toThrow(/timeout|abort/i);
  });
});

describe('fetchAsset', () => {
  it('reduces a feed-controlled path to its basename before it touches disk', async () => {
    stubFetchWith('zip-bytes');
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-asset-'));

    const destination = await fetchAsset('../../evil.zip', 'v1.0.0', dir, 1_000);

    expect(destination).toBe(join(dir, 'evil.zip'));
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(resolve(dir, '..', '..', 'evil.zip'))).toBe(false);
  });
});

describe('sha512Of', () => {
  it('digests a file identically to the whole-buffer hash it replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-sha-'));
    const file = join(dir, 'blob.bin');
    const payload = randomBytes(64 * 1024);
    await writeFile(file, payload);

    expect(await sha512Of(file)).toBe(createHash('sha512').update(payload).digest('base64'));
  });
});

describe('dismiss', () => {
  const settingsIn = (dir: string): string => join(dir, 'update-settings.json');

  it('does not persist a version nobody offered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-dismiss-'));
    const updater = createUpdater({ userDataDir: dir, broadcast: () => undefined });

    const state = await updater.dismiss('9.9.9');

    expect(state.phase).toBe('idle');
    expect(existsSync(settingsIn(dir))).toBe(false);
  });

  // The offer is produced by a real (manual) check against a stubbed feed, so
  // this needs the platform the updater actually supports.
  it.runIf(process.platform === 'darwin')(
    'persists exactly the version on offer, and only that one',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'artemis-test-dismiss-'));
      const updater = createUpdater({ userDataDir: dir, broadcast: () => undefined });
      stubFetchWith('version: 9.9.9\npath: Artemis-9.9.9-arm64-mac.zip\nsha512: irrelevant\n');

      await expect(updater.checkNow()).resolves.toEqual({ kind: 'offered', version: '9.9.9' });

      // A version that is not the one on the card changes nothing: no file,
      // and the offer stays up.
      await updater.dismiss('1.2.3');
      expect(updater.state().phase).toBe('available');
      expect(existsSync(settingsIn(dir))).toBe(false);

      // The offered version is a real decision: recorded, and the card comes
      // down.
      const state = await updater.dismiss('9.9.9');
      expect(state.phase).toBe('idle');
      expect(JSON.parse(await readFile(settingsIn(dir), 'utf8'))).toEqual({
        dismissedVersion: '9.9.9',
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Staying on the newest release                                              */
/* -------------------------------------------------------------------------- */

/*
 * The bug both of these come from: an offer was made once and then believed
 * forever. Running 1.10.0 and offered 1.10.1, a machine went on downloading
 * 1.10.1 after 1.11.0 had shipped — the menu's check answered with the version
 * on the card instead of reading the feed, and the install fetched whatever the
 * card had been holding since it appeared.
 */

/*
 * Which file this machine asks a release for.
 *
 * Pinned because the answer is a contract with CI rather than with anything in
 * this repository: `release.yml` renames electron-builder's `latest-mac.yml`
 * per architecture and uploads the Windows build's `latest.yml` untouched, and
 * a rename on either side that these names do not follow is an updater that
 * 404s on every check with nothing in the app to show for it.
 */
describe('the feed this platform reads', () => {
  const onPlatform = <T,>(platform: string, arch: string, read: () => T): T => {
    const platformWas = Object.getOwnPropertyDescriptor(process, 'platform');
    const archWas = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    try {
      return read();
    } finally {
      if (platformWas) Object.defineProperty(process, 'platform', platformWas);
      if (archWas) Object.defineProperty(process, 'arch', archWas);
    }
  };

  it('asks for its own Linux feed, and the package it names', () => {
    // electron-builder's `latest-linux.yml` names the AppImage; the Arch
    // updater installs the .pacman, so the feed it reads is a different file
    // written by `scripts/linux-update-feed.ts`.
    expect(onPlatform('linux', 'x64', feedName)).toBe('latest-linux-pacman.yml');
    expect(onPlatform('linux', 'x64', artifactExtension)).toBe('.pacman');
  });

  it('asks for one feed per mac architecture, and the zip they name', () => {
    expect(onPlatform('darwin', 'arm64', feedName)).toBe('latest-mac-arm64.yml');
    expect(onPlatform('darwin', 'x64', feedName)).toBe('latest-mac-x64.yml');
    expect(onPlatform('darwin', 'arm64', artifactExtension)).toBe('.zip');
  });

  it("asks Windows for electron-builder's own latest.yml, and the setup exe it names", () => {
    // Not renamed per architecture the way the mac feeds are: only one Windows
    // build is published, so `latest.yml` arrives from the builder untouched.
    expect(onPlatform('win32', 'x64', feedName)).toBe('latest.yml');
    expect(onPlatform('win32', 'x64', artifactExtension)).toBe('.exe');
  });
});

describe('feedToInstall', () => {
  const feed = (version: string): UpdateFeed => ({
    version,
    artifactPath: `Artemis-${version}-arm64-mac.zip`,
    sha512: `sha-${version}`,
  });

  it('takes a release that has appeared since the offer was made', () => {
    const latest = feed('1.11.0');
    expect(feedToInstall(feed('1.10.1'), latest)).toBe(latest);
  });

  it('keeps the offer when the re-read produced nothing usable', () => {
    // A feed that did not parse is not evidence against the offer, and turning
    // a transient failure into a dead Update button would be a worse bug than
    // the stale version this re-read exists to fix.
    expect(feedToInstall(feed('1.10.1'), null)).toEqual(feed('1.10.1'));
  });

  it('never moves the install backwards', () => {
    // A feed *older* than the offer means the channel moved under it — a pulled
    // release, or a beta user switched to stable. Downgrading silently is the
    // one outcome nobody clicked Update for.
    const offer = feed('1.10.1');
    expect(feedToInstall(offer, feed('1.10.0'))).toBe(offer);
    expect(feedToInstall(offer, feed('1.10.1'))).toBe(offer);
  });
});

// Each of these drives a real check against a stubbed feed, so they need a
// platform the updater actually supports — which is *both* of them, and used
// to be read as macOS alone. That reading is what let an unconditional
// `/bin/rm` in the cleanup path turn every Windows check into an unreachable
// feed across three releases: the tests that would have caught it on the spot
// were the ones being skipped there.
describe.runIf(process.platform === 'darwin' || process.platform === 'win32')(
  'checking again over a standing offer',
  () => {
    // The feed names the artifact this platform installs, because a feed naming
    // any other extension is refused by `parseUpdateFeed` and would make every
    // case below pass for the wrong reason.
    const feedFor = (version: string): string => {
      const artifact =
        process.platform === 'win32'
          ? `Artemis-${version}-x64-setup.exe`
          : `Artemis-${version}-arm64-mac.zip`;
      return `version: ${version}\npath: ${artifact}\nsha512: irrelevant\n`;
    };

    const updaterInTemp = async (): Promise<ReturnType<typeof createUpdater>> =>
      createUpdater({
        userDataDir: await mkdtemp(join(tmpdir(), 'artemis-test-recheck-')),
        broadcast: () => undefined,
      });

    it('reports what it read rather than an unreachable feed', async () => {
      // The plainest thing a check can be asked, and the one that was false on
      // Windows for three releases: the feed downloaded, parsed and compared
      // fine, and then the cleanup that ran after the answer was in hand threw
      // and took the answer with it.
      const updater = await updaterInTemp();
      stubFetchWith(feedFor('9.9.9'));

      await expect(updater.checkNow()).resolves.toEqual({ kind: 'offered', version: '9.9.9' });
    });

    it('leaves nothing of its own behind in the temp directory', async () => {
      // Each check works in a fresh `artemis-update-check-` directory and is
      // meant to take it away again. The husks are what a failing cleanup
      // leaves, and on Windows there was one per check, forever.
      const updater = await updaterInTemp();
      const before = leftoverCheckDirs();
      stubFetchWith(feedFor('9.9.9'));

      await updater.checkNow();

      expect(leftoverCheckDirs()).toEqual(before);
    });

    it('replaces the offer when a newer release has shipped since', async () => {
      const updater = await updaterInTemp();
      stubFetchWith(feedFor('9.9.9'));
      await expect(updater.checkNow()).resolves.toEqual({ kind: 'offered', version: '9.9.9' });

      stubFetchWith(feedFor('10.0.0'));
      await expect(updater.checkNow()).resolves.toEqual({ kind: 'offered', version: '10.0.0' });
      expect(updater.state()).toMatchObject({ phase: 'available', version: '10.0.0' });
    });

    it('leaves the card exactly as it was when the feed cannot be read', async () => {
      const updater = await updaterInTemp();
      stubFetchWith(feedFor('9.9.9'));
      await updater.checkNow();

      // A proxy's error page, or anything else that is not a feed.
      stubFetchWith('<html><body>404</body></html>');
      await expect(updater.checkNow()).resolves.toEqual({ kind: 'unreachable' });
      expect(updater.state()).toMatchObject({ phase: 'available', version: '9.9.9' });
    });

    /*
     * The periodic check, driven for real: `start()` puts the first one 15
     * seconds out, so the clock is faked to get there. Nothing else in the path
     * is timer-driven — the stubbed fetch, `mkdtemp` and the tree removal all
     * run on the event loop — which is why `waitFor` can pick up the result
     * afterwards.
     */
    it('refreshes a card nobody has touched when a newer release ships', async () => {
      vi.useFakeTimers();
      const updater = await updaterInTemp();
      try {
        stubFetchWith(feedFor('9.9.9'));
        await updater.checkNow();
        expect(updater.state().version).toBe('9.9.9');

        // The card sits there. A newer release ships, and the timer is the only
        // thing that notices — which is the case this whole path exists for.
        stubFetchWith(feedFor('10.0.0'));
        updater.start();
        await vi.advanceTimersByTimeAsync(20_000);
        await vi.waitFor(() => {
          expect(updater.state()).toMatchObject({ phase: 'available', version: '10.0.0' });
        });
      } finally {
        updater.stop();
        vi.useRealTimers();
      }
    });

    it('takes the card down when the feed no longer offers anything newer', async () => {
      // The offered release was pulled after it was published: the card is
      // holding a version that would 404 at the download, so it comes down.
      const updater = await updaterInTemp();
      stubFetchWith(feedFor('9.9.9'));
      await updater.checkNow();

      stubFetchWith(feedFor('0.1.0')); // …which is the running version.
      await expect(updater.checkNow()).resolves.toEqual({ kind: 'current' });
      expect(updater.state().phase).toBe('idle');
    });
  },
);

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * The reason this exists at all: the archive is ~196MB, `working` was one
 * static sentence for the minutes that takes, and a user who could not tell a
 * download from a hang clicked Update three times. What follows pins the two
 * halves of the fix — that the bytes are actually counted, and that counting
 * them does not turn into an IPC flood.
 */

describe('download progress', () => {
  it('counts bytes to the total the server promised', async () => {
    const payload = randomBytes(96 * 1024);
    const origin = await serve((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.length),
      });
      response.end(payload);
    });
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-progress-'));
    const file = join(dir, 'big.zip');
    const readings: { transferred: number; total: number | null }[] = [];

    await fetchAnonymously(`${origin}/big.zip`, file, 5_000, (transferred, total) => {
      readings.push({ transferred, total });
    });

    expect(readings.length).toBeGreaterThan(0);
    // Monotonic, ending exactly on the total: a bar that goes backwards or
    // stops short is the thing a user reads as stuck.
    expect(readings.map((r) => r.transferred)).toEqual(
      [...readings.map((r) => r.transferred)].sort((a, b) => a - b),
    );
    expect(readings.at(-1)).toEqual({ transferred: payload.length, total: payload.length });
    // And the file still arrived whole — the counter is in the pipeline, so a
    // mistake here would corrupt the download rather than merely misreport it.
    expect((await readFile(file)).equals(payload)).toBe(true);
  });

  it('reports an unknown total rather than guessing one', async () => {
    // No `content-length`: chunked, or a proxy that re-encoded. `null` is what
    // lets the surface draw an indeterminate bar instead of a lie.
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write(randomBytes(1024));
      response.end(randomBytes(1024));
    });
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-progress-'));
    const totals: (number | null)[] = [];

    await fetchAnonymously(`${origin}/x.zip`, join(dir, 'x.zip'), 5_000, (_transferred, total) => {
      totals.push(total);
    });

    expect(totals.length).toBeGreaterThan(0);
    expect(totals.every((total) => total === null)).toBe(true);
  });
});

describe('verify progress', () => {
  it('counts the hash against the file’s own size, and still digests correctly', async () => {
    // Hashing 196MB is seconds of a surface that would otherwise sit at a
    // finished download — so this step counts too, and its total is knowable.
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-sha-progress-'));
    const file = join(dir, 'blob.bin');
    const payload = randomBytes(128 * 1024);
    await writeFile(file, payload);
    const readings: { transferred: number; total: number | null }[] = [];

    const digest = await sha512Of(file, (transferred, total) => {
      readings.push({ transferred, total });
    });

    expect(digest).toBe(createHash('sha512').update(payload).digest('base64'));
    expect(readings.at(-1)).toEqual({ transferred: payload.length, total: payload.length });
  });

  it('digests without a callback exactly as it always did', async () => {
    // The no-progress path must not pay for the feature: no stat, no counter.
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-sha-plain-'));
    const file = join(dir, 'blob.bin');
    const payload = randomBytes(4 * 1024);
    await writeFile(file, payload);

    expect(await sha512Of(file)).toBe(createHash('sha512').update(payload).digest('base64'));
  });
});

describe('throttleProgress', () => {
  const reading = (transferred: number, total: number | null = 100): UpdateProgress => ({
    step: 'downloading',
    transferred,
    total,
  });

  it('lets the first reading through immediately', () => {
    // The first is what replaces "nothing is happening" with a bar. Holding it
    // for an interval is holding the only frame that matters.
    const seen: UpdateProgress[] = [];
    const emit = throttleProgress((p) => seen.push(p), 100, () => 1_000);

    emit(reading(1));

    expect(seen).toEqual([reading(1)]);
  });

  it('drops the flood between intervals', () => {
    // ~3000 chunks over a 196MB archive, each crossing IPC to every window.
    let now = 1_000;
    const seen: UpdateProgress[] = [];
    const emit = throttleProgress((p) => seen.push(p), 100, () => now);

    emit(reading(1));
    now = 1_050;
    emit(reading(2));
    now = 1_099;
    emit(reading(3));
    now = 1_100;
    emit(reading(4));

    expect(seen.map((p) => p.transferred)).toEqual([1, 4]);
  });

  it('always emits the reading that completes the step', () => {
    // Otherwise the bar rests at 97% while the next step runs, which reads as
    // the stall this whole feature exists to remove.
    let now = 1_000;
    const seen: UpdateProgress[] = [];
    const emit = throttleProgress((p) => seen.push(p), 100, () => now);

    emit(reading(1));
    now = 1_001;
    emit(reading(100));

    expect(seen.map((p) => p.transferred)).toEqual([1, 100]);
  });

  it('does not mistake an uncountable step for a finished one', () => {
    // `null` totals mean "cannot say", and treating that as complete would
    // exempt every reading of an indeterminate step from the throttle.
    let now = 1_000;
    const seen: UpdateProgress[] = [];
    const emit = throttleProgress((p) => seen.push(p), 100, () => now);

    emit(reading(1, null));
    now = 1_050;
    emit(reading(2, null));

    expect(seen).toHaveLength(1);
  });
});

/*
 * Which Linux installs Artemis may replace.
 *
 * The Arch path rests entirely on one question — does pacman own the running
 * executable — because that is what decides whether `pacman -U` is Artemis's
 * to call or someone else's business. An AppImage on an Arch machine must
 * answer no as firmly as a Debian one does.
 */
describe('ownedByPacman', () => {
  const onPlatform = (platform: string, read: () => boolean): boolean => {
    const was = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    forgetPacmanOwnership();
    try {
      return read();
    } finally {
      if (was) Object.defineProperty(process, 'platform', was);
      forgetPacmanOwnership();
    }
  };

  it('is false on every platform that has no pacman at all', () => {
    expect(onPlatform('darwin', ownedByPacman)).toBe(false);
    expect(onPlatform('win32', ownedByPacman)).toBe(false);
  });

  it('answers for this executable and this package, not merely for the machine', () => {
    /*
     * The suite runs under node, and on Arch `/usr/bin/node` is owned by the
     * `nodejs` package — so a check that only asked "does pacman own this
     * file" would answer yes here, and on a developer's machine that is the
     * difference between "no updater" and "an updater offering to pacman -U
     * an Artemis release over your node install". The owning package has to
     * be Artemis. On any machine without pacman this never asks at all, and
     * lands on the same answer.
     */
    expect(onPlatform('linux', ownedByPacman)).toBe(false);
  });

  it('remembers, so the menu and the timer cannot disagree mid-session', () => {
    const first = onPlatform('linux', ownedByPacman);
    forgetPacmanOwnership();
    expect(onPlatform('linux', ownedByPacman)).toBe(first);
  });
});
