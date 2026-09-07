/**
 * The updater: finds a newer release, fetches it, verifies it, installs it, and
 * relaunches.
 *
 * ## Why not electron-updater
 *
 * Artemis ships unsigned — an internal decision, documented in the release
 * notes — and electron-updater's macOS path hard-requires a signed app: its
 * embedded Squirrel.Mac validates the code signature of the downloaded update
 * against the running app and refuses ad-hoc builds. So the mechanism here is
 * the plain one: download the artifact electron-builder already publishes,
 * check its sha512 against the feed, and install it the way this platform
 * installs things. Every step before that last one leaves the installed app
 * untouched.
 *
 * ## One updater, two installs
 *
 * The download, the verification, the feed and the state machine are shared;
 * only the last step differs, and it differs because the platforms do:
 *
 *   - **macOS** — `ditto`-extract the zip, rename the old bundle aside, rename
 *     the new one in. Two renames on one volume with a rollback, and the
 *     running process keeps executing fine from its renamed bundle because open
 *     files follow the inode rather than the path.
 *   - **Windows** — download the NSIS setup exe, verify it, park it, and hand
 *     over to it on the restart click (`/S --force-run`). A running `.exe`
 *     cannot be renamed over itself, and replacing files that were just in use
 *     is precisely what an installer is for, so the swap is the installer's job
 *     rather than this module's.
 *
 *   - **Arch** — download the `.pacman` this release published, verify it,
 *     park it, and on the restart click hand it to `pacman -U` through
 *     `pkexec`. A package manager's install is still the package manager's
 *     business; what changed is that Artemis can now *ask* it, rather than
 *     leaving the user to do the download, the checksum and the command by
 *     hand. Unlike the Windows hand-over this waits for the result, because
 *     the one failure that matters here — no polkit authentication agent in
 *     the session — is recoverable, and the answer to it is a command the
 *     user can paste against a file that is already downloaded and verified.
 *
 * The rest of Linux is still absent, and for the original reason: a `.deb`
 * install would work the same way but has never been exercised, and an
 * AppImage is a file the user placed somewhere Artemis has no business
 * replacing. {@link installTarget} answers `null` there, a check answers
 * `unsupported`, and no network request is made at all.
 *
 * ## Where the releases live, and how they are reached
 *
 * Releases sit on the same GitHub repository this build was published from
 * (`electron-builder.yml`'s `publish` block, `scripts/release.ts`), and that
 * repository is public. So the ordering here is the reverse of what it was:
 *
 *   1. Anonymous HTTPS against the public release URLs. No credential, no
 *      tooling, no account — every machine that can reach github.com can
 *      update, which is the whole dividend of going public.
 *   2. `gh release download` with the user's own GitHub CLI login, when a
 *      usable `gh` exists. No longer the route that grants *access*, only a
 *      second way through: a proxy that mangles the CDN redirect, a transient
 *      5xx, an enterprise network that trusts `gh` and not much else.
 *
 * While the repository was private these were the other way around, because
 * private meant authenticated and Artemis holds no credentials — the same
 * answer as `claude auth login`: the user's own tooling holds the credential.
 * That is still true, and now nothing needs to hold one. No token is stored,
 * asked for, or accepted. A machine with neither route simply never sees a
 * banner, and the release notes remain the manual path.
 *
 * ## What the renderer sees
 *
 * One {@link UpdateState}, pushed on every change. No URL, no path, no
 * checksum crosses the IPC boundary — the renderer's whole vocabulary is
 * "there is a version", "install it", "not this one".
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, existsSync, constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
// `rm` is what clears the pending-update directory, which holds a single
// downloaded installer, and what `removeTree` reduces to off macOS. Removing a
// tree that can hold an *app bundle* is the case that cannot use it directly,
// for a reason documented on `removeTree` below.
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { app } from 'electron';
import { ARTEMIS_RELEASES_URL, ARTEMIS_REPO } from '@rx-artemis/protocol';
import type { UpdateProgress, UpdateState, UpdateStep } from '@rx-artemis/protocol';

import { createLogger } from './log.js';
import { APP_NAME } from './appNames.js';
import { tagForChannel, type ReleaseSummary, type UpdateChannel } from './updateChannel.js';
import { decideOffer, isNewerVersion, parseUpdateFeed, type UpdateFeed } from './updateFeed.js';

const execFileAsync = promisify(execFile);

const log = createLogger('updater');

/**
 * The repository releases are published to, from the protocol rather than from
 * a literal here.
 *
 * It moved there when the About pane started showing the releases page
 * standing: the renderer needs the same page this module downloads from, and a
 * second copy of the slug would be a third thing to keep in lockstep — the
 * comment this replaced named three and there were four, the dev mock having
 * quietly kept the pre-move URL.
 *
 * Still by hand against the `publish` block in
 * `apps/desktop/electron-builder.yml`: there is no runtime accessor for the
 * builder's config, the same situation as `appId`, and that block is the one
 * baked into each build. See {@link ARTEMIS_REPO}.
 */
const REPO = ARTEMIS_REPO;
const RELEASES_URL = ARTEMIS_RELEASES_URL;

/**
 * The feed for *this* machine: one file per platform, and one per mac
 * architecture (CI renames electron-builder's `latest-mac.yml` per build — see
 * `.github/workflows/release.yml`), because a feed's top-level `path` is the
 * artifact to install and an Intel Mac must never be handed the arm64 zip, nor
 * Windows the mac bundle.
 *
 * A function rather than a constant because it is now two questions rather than
 * one, and the Linux answer is a placeholder: `installTarget` returns null there
 * long before anything asks for a feed, so the name is never fetched.
 */
export function feedName(): string {
  if (process.platform === 'darwin') {
    return `latest-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.yml`;
  }
  /*
   * Linux has its own feed because electron-builder's `latest-linux.yml`
   * names the AppImage — the only Linux target it considers updatable — and
   * the artifact Artemis installs there is the `.pacman`. So the release job
   * writes this one itself (`scripts/linux-update-feed.ts`), in the same
   * three fields the others carry.
   */
  if (process.platform === 'linux') return 'latest-linux-pacman.yml';
  return 'latest.yml';
}

/**
 * What this platform's installer can actually consume — see
 * {@link parseUpdateFeed}, which refuses a feed naming anything else. The mac
 * swap eats a zip; Windows runs a setup exe.
 */
export function artifactExtension(): string {
  if (process.platform === 'darwin') return '.zip';
  if (process.platform === 'linux') return '.pacman';
  return '.exe';
}

/**
 * The releases API, used only by the beta channel.
 *
 * Stable never calls it: `/releases/latest` on the download host already
 * excludes prereleases, so stable resolves with no API request at all. Beta
 * cannot use that endpoint — skipping prereleases is precisely what it must not
 * do — so it lists releases and picks the newest itself.
 *
 * Unauthenticated, which is rate-limited to 60 requests an hour per IP. The
 * updater checks every four hours, so that is roughly 240 times more headroom
 * than needed, and a rate-limit answer is treated like any other unreachable
 * feed: no banner today.
 */
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;

/**
 * How long the pacman hand-over may take before it is called a failure.
 *
 * Long enough for someone to notice a dialog, find their password and type
 * it; short enough that a session with no authentication agent — where
 * `pkexec` waits rather than failing — ends in an explanation instead of a
 * spinner that never stops.
 */
const PACMAN_INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const RELEASES_FETCH_TIMEOUT_MS = 15_000;

/** First check shortly after launch; then steadily. Both deliberately lazy —
 * an update is never urgent enough to compete with startup. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Where a pending Windows installer waits between `ready` and the restart click.
 *
 * Under `userData` rather than in the staging temp directory, because `ready` is
 * a state a machine can sit in for days: the download is finished, the app is
 * still the old one, and the install happens whenever the user gets round to
 * restarting. A temp directory swept by the OS in the meantime would turn that
 * wait into a `ready` state with nothing behind it.
 */
const PENDING_DIR_NAME = 'pending-update';

/**
 * Deadlines on the anonymous downloads.
 *
 * The subprocess routes have always had these — `gh` gets ten minutes, `ditto`
 * and `rm` five — but the `fetch` route had none, and a server that answers
 * and then drips bytes forever would hold `checking` (or `installing`) set
 * until relaunch, with the menu item greyed out for the duration. The feed is
 * a few hundred bytes, so thirty seconds is already generous; the zip is
 * ~196MB and gets the same ten minutes the `gh` fallback allows it.
 */
const FEED_FETCH_TIMEOUT_MS = 30_000;
const ZIP_FETCH_TIMEOUT_MS = 10 * 60 * 1000;

/** Where `gh` tends to live when a GUI launch doesn't inherit the shell's PATH. */
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')];

const IDLE: UpdateState = {
  phase: 'idle',
  version: null,
  message: null,
  releaseUrl: null,
  progress: null,
};

/**
 * How often a step in flight may push a new state, in milliseconds.
 *
 * The download hands over a chunk every few hundred kilobytes — some thousands
 * of them across a 196MB archive — and every push crosses the IPC boundary to
 * every open window and re-renders two surfaces. At ten a second the bar is
 * smooth to the eye and the traffic is nothing; unthrottled it is a flood in
 * service of frames nobody can see.
 */
const PROGRESS_INTERVAL_MS = 100;

/**
 * Wrap `emit` so it fires at most every `intervalMs` — plus always on the
 * first reading, and always on the one that completes the step.
 *
 * Those two ends are not an optimisation, they are the readings that carry the
 * meaning: the first is what replaces "nothing is happening" with a bar, and
 * the last is what leaves it full rather than stranded at 97% while the next
 * step runs. `clock` is a parameter so the rule can be tested without waiting.
 */
export function throttleProgress(
  emit: (progress: UpdateProgress) => void,
  intervalMs: number = PROGRESS_INTERVAL_MS,
  clock: () => number = Date.now,
): (progress: UpdateProgress) => void {
  let last: number | null = null;
  return (progress) => {
    const now = clock();
    const done =
      progress.total !== null &&
      progress.transferred !== null &&
      progress.transferred >= progress.total;
    if (last !== null && !done && now - last < intervalMs) return;
    last = now;
    emit(progress);
  };
}

/**
 * What one check found — the answer to a question somebody asked out loud.
 *
 * The periodic check does not need this: finding nothing is the overwhelmingly
 * common case and the right response to it is silence, which is why `check`
 * used to return `void`. A person who chooses *Check for Updates…* has asked a
 * question, and every one of these outcomes is an answer they are owed,
 * including the three that leave the screen exactly as it was.
 */
export type CheckOutcome =
  /** Something newer exists; the state is now `available` and the card is up. */
  | { readonly kind: 'offered'; readonly version: string }
  /** The feed was read and this build is not behind it. */
  | { readonly kind: 'current' }
  /** No `gh`, no network, no access. Indistinguishable from here, and the same advice. */
  | { readonly kind: 'unreachable' }
  /**
   * An install or restart is already under way; the card is already saying so.
   *
   * No longer what a standing offer answers with — that is re-read now — so
   * this means work in flight, including work that started while this very
   * check was reading the feed.
   */
  | { readonly kind: 'busy' }
  /** Nothing a check could act on: a dev build, or a platform the swap is not written for. */
  | { readonly kind: 'unsupported' };

export interface Updater {
  /** The state right now, for the pull channel. */
  state(): UpdateState;
  /**
   * Set which releases this installation will be offered, and report the state
   * unchanged — the channel decides what a *future* check sees, and changing it
   * deliberately does not kick one off. Someone toggling a setting has not
   * asked to download anything.
   */
  setChannel(channel: UpdateChannel): UpdateState;
  /**
   * Check now, because someone asked, and say what was found.
   *
   * Differs from the periodic check in three ways, all of them following from
   * the question having been asked deliberately: a version the user dismissed
   * is offered again (choosing to ask is the opposite of having declined), a
   * failed check is a state worth leaving so `error` is a valid phase to check
   * from, and the outcome comes back to the caller instead of only ever
   * reaching the screen when it is good news.
   *
   * What it does *not* differ in, any more, is re-reading: both checks replace
   * a standing offer with what the feed says now. "Check for updates" means the
   * newest release that exists, not the newest one this process has heard of,
   * and the timer means the same thing four hours later.
   */
  checkNow(): Promise<CheckOutcome>;
  /**
   * Begin check → download → verify → swap, parking at `ready`. Resolves once
   * underway.
   *
   * The check at the front re-reads the feed, so what is installed is the
   * newest release at the moment of the click rather than the one the card has
   * been showing since it appeared — see `supersede`.
   */
  install(): UpdateState;
  /** Relaunch into an installed update. A read unless the phase is `ready`. */
  restart(): UpdateState;
  /** Silence one version. */
  dismiss(version: string): Promise<UpdateState>;
  /** Start the periodic check. Idempotent. */
  start(): void;
  /** Stop checking and drop timers. */
  stop(): void;
}

export interface UpdaterOptions {
  readonly userDataDir: string;
  /** Push one state at every open window. Wired to the IPC broadcast. */
  readonly broadcast: (state: UpdateState) => void;
}

/**
 * Delete a directory tree: `/bin/rm` on macOS, `fs.rm` everywhere else.
 *
 * ## Not `fs.rm` on macOS, and not as a matter of taste
 *
 * Electron patches `fs` so that an `.asar` archive is transparently a
 * *directory*. Every tree removed on the macOS path can contain one — a parked
 * app bundle and the staging directory both hold `Contents/Resources/app.asar`
 * — so a recursive `fs.rm` descends *into* the archive rather than unlinking
 * it, cannot empty the directory it believes it is looking at, and fails with
 * `ENOTEMPTY`. `force: true` does not cover that: it swallows `ENOENT` only.
 *
 * What shipped, from the updater's first release through 0.5.0, was therefore a
 * husk of exactly one file — `Contents/Resources/app.asar`, around 6.5MB — left
 * in /Applications by every self-update, and another in the temp directory.
 *
 * `process.noAsar = true` fixes it too, and is worse here: it is a
 * process-global flag, so holding it across an `await` disables asar resolution
 * for everything else in the main process, including a window loading its
 * renderer entry from inside `app.asar`. `/bin/rm` holds no opinion about asar
 * and is the idiom `ditto` above already establishes for the macOS install.
 *
 * ## Why the branch exists
 *
 * `/bin/rm` was unconditional through 2.4.2, on the reasoning that it "exists
 * on the only platform the updater runs on" — which was false the moment
 * {@link supported} started answering `true` for `win32`. On Windows that path
 * resolves against the current drive as `C:\bin\rm`, so every call rejected
 * with `ENOENT`, and because {@link createUpdater}'s `readFeed` awaited this in
 * a `finally`, a feed that had downloaded and parsed perfectly was discarded
 * and reported as an unreachable one. Every Windows install from 2.3.0 to 2.4.2
 * therefore claimed it could not reach the update server, on a machine that had
 * just reached it, and could only be updated by hand.
 *
 * Windows needs no subprocess to get this right. Nothing it removes holds an
 * `.asar`: its artifact is a setup exe, so the staging tree holds that, the
 * check tree holds a feed file, and the parked-bundle sweep is macOS-only. The
 * reason for shelling out simply does not arise, and `fs.rm` is already the
 * idiom `sweepLeftovers` uses on `pendingDir` for exactly that reason.
 *
 * Exported so the Windows CI job can pin it. "Which of these can contain an
 * .asar?" is the question that produced the 0.5.0 bug and "which platform is
 * this?" is the question that produced this one; neither is left standing.
 */
export async function removeTree(path: string): Promise<void> {
  if (process.platform !== 'darwin') {
    await rm(path, { recursive: true, force: true });
    return;
  }
  await execFileAsync('/bin/rm', ['-rf', path], { timeout: 5 * 60 * 1000 });
}

/* -------------------------------------------------------------------------- */
/* Reaching the release                                                       */
/* -------------------------------------------------------------------------- */

// These lived inside `createUpdater` until the fetch route grew a deadline.
// None of them ever touched the updater's state, and at module scope the two
// with behaviour worth pinning — the timeout and the basename reduction — are
// exported where a test can reach them.

/**
 * An executable `gh`, from PATH or the usual homes, or null.
 *
 * `gh.exe` first on Windows, because a bare `gh` is not a program there and
 * the installed CLI is `gh.exe` — so the fallback route this function exists
 * to find was never once found on Windows, and every anonymous failure went
 * straight to the user as a dead end. It stays in the candidate list behind
 * `.exe` only to cover a shim someone put on PATH themselves.
 */
function resolveGh(): string | null {
  const names = process.platform === 'win32' ? ['gh.exe', 'gh'] : ['gh'];
  const fromPath = (process.env['PATH'] ?? '').split(delimiter);
  for (const dir of [...fromPath, ...EXTRA_BIN_DIRS]) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** Env for `gh`, with PATH widened so its own helpers resolve under a GUI launch. */
function ghEnv(): NodeJS.ProcessEnv {
  const path = [process.env['PATH'] ?? '', ...EXTRA_BIN_DIRS].filter(Boolean).join(delimiter);
  return { ...process.env, PATH: path };
}

/**
 * Download one release asset into `dir`: the public URL first, `gh` as the
 * fallback. `tag` is empty for "latest release".
 *
 * Both routes are tried for every asset, so a feed read and a 196MB zip take
 * the same path and a failure in the first is never fatal on its own — see the
 * file header for why the anonymous route leads now.
 */
export async function fetchAsset(
  name: string,
  tag: string,
  dir: string,
  timeoutMs: number,
  onProgress?: (transferred: number, total: number | null) => void,
): Promise<string> {
  // `name` is feed-controlled when it is the zip's `path`. The feed comes from
  // the repository this build was published from, so a hostile value here
  // means that repository — or the channel to it — is already compromised, and
  // an attacker that far in has better moves than a crafted filename. But "the
  // feed is trusted" must not be the only thing standing between a
  // `path: ../../x.zip` and a write outside the staging directory, so the
  // value is reduced to a bare filename before it touches the filesystem.
  const asset = basename(name);
  const destination = join(dir, asset);
  const url =
    tag === ''
      ? `${RELEASES_URL}/latest/download/${asset}`
      : `${RELEASES_URL}/download/${tag}/${asset}`;
  try {
    await fetchAnonymously(url, destination, timeoutMs, onProgress);
    return destination;
  } catch (error) {
    const gh = resolveGh();
    if (gh === null) throw error;
    // Worth a line: a machine that quietly updates through `gh` every time is
    // a machine whose plain HTTPS route is broken, and nothing else would say
    // so until the day `gh` is uninstalled.
    // Nothing counts bytes on this route — it shells out — so the caller's
    // last reading stands and the surface keeps an indeterminate bar. A bar
    // that stops moving is better than one that invents movement.
    log.debug(`Anonymous download of ${asset} failed; falling back to gh.`, error);
    const args = ['release', 'download'];
    if (tag !== '') args.push(tag);
    args.push('-R', REPO, '-p', asset, '-D', dir, '--clobber');
    await execFileAsync(gh, args, { env: ghEnv(), timeout: 10 * 60 * 1000 });
    return destination;
  }
}

/**
 * GET `url` to `destination`, streamed, abandoned after `timeoutMs`.
 *
 * Streamed and not `Buffer.from(await response.arrayBuffer())`, which is what
 * this was while it was dead code behind the `gh` route. The largest thing it
 * fetched then was a 500-byte feed; the largest thing it fetches now is the
 * release zip, which is around 196MB and would otherwise be held in the
 * privileged process's heap in one piece — twice over, for the moment the
 * Buffer copy and the ArrayBuffer both exist — before a byte reached disk.
 *
 * The timeout is one signal over the whole transfer — connect, headers, and
 * every body chunk — because the failure worth defending against is not the
 * refused connection, which already rejects on its own, but the server that
 * answers and then stalls. The same signal is handed to the pipeline so the
 * half-written destination stream is destroyed rather than left open.
 */
export async function fetchAnonymously(
  url: string,
  destination: string,
  timeoutMs: number,
  onProgress?: (transferred: number, total: number | null) => void,
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  if (response.body === null) throw new Error(`GET ${url} answered without a body`);
  /*
   * Counted by a transform in the middle of the pipeline rather than by a
   * `data` listener on the source: a listener switches the stream to flowing
   * mode and would race `pipeline`'s own consumption of it. A transform sees
   * every chunk on its way past and changes nothing about the transfer.
   *
   * `content-length` is absent often enough to matter — a chunked response, a
   * proxy that re-encodes — and is reported as `null` rather than guessed at,
   * so the surface can draw an honest indeterminate bar instead of one that
   * lies. See `updatePercent`.
   */
  const total = totalFromHeader(response.headers.get('content-length'));
  let transferred = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      transferred += chunk.length;
      onProgress?.(transferred, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(destination), {
    signal,
  });
}

/** A `content-length` worth believing, or `null`. */
function totalFromHeader(header: string | null): number | null {
  if (header === null) return null;
  const total = Number(header);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * The sha512 of `file`, streamed.
 *
 * Streamed for the same reason the download above is: the one file this is
 * ever asked about is the ~196MB release zip, and `readFile` would hold the
 * whole of it in the privileged process's heap for the sake of one digest —
 * the exact spike the streamed download just avoided.
 */
export async function sha512Of(
  file: string,
  onProgress?: (transferred: number, total: number | null) => void,
): Promise<string> {
  const hash = createHash('sha512');
  /*
   * Unlike the download, this step can always count: the total is the file's
   * own size. Worth counting, too — hashing 196MB is seconds during which a
   * surface reporting the download would otherwise sit frozen at 100%.
   */
  const total = onProgress === undefined ? null : await sizeOf(file);
  let transferred = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      transferred += chunk.length;
      onProgress?.(transferred, total);
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(file), counter, hash);
  return hash.digest('base64');
}

/**
 * Which release an install should actually fetch: the one that was offered, or
 * a newer one the feed has picked up since.
 *
 * The rule, in the one place it can be read without following a download
 * through four steps of side effects:
 *
 *   - a feed that did not parse, or was not there, changes nothing — the offer
 *     stands, because a failed re-read is not evidence against it
 *   - only strictly newer supersedes, so the install can move forward and
 *     never back
 *
 * See `supersede` for why the re-read happens at all.
 */
export function feedToInstall(offer: UpdateFeed, latest: UpdateFeed | null): UpdateFeed {
  if (latest === null) return offer;
  return isNewerVersion(latest.version, offer.version) ? latest : offer;
}

/** A file's size, or `null` if it cannot be read — a denominator is never worth failing over. */
async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/**
 * What an in-place install would replace on this platform.
 *
 * A union rather than a nullable path because the two installs do not have the
 * same shape: the mac one names a bundle it is going to rename, and the Windows
 * one names nothing at all — the installer finds its own install. Discriminating
 * on `kind` is what stops `runInstall` from reaching for a `bundle` that a
 * Windows target was never going to carry.
 */
type InstallTarget =
  | { readonly kind: 'mac-bundle'; readonly bundle: string }
  | { readonly kind: 'windows-installer' }
  | { readonly kind: 'pacman-package' };

/** `pacman`, and the package database it would have to consult. */
const PACMAN_BIN = '/usr/bin/pacman';
const PKEXEC_BIN = '/usr/bin/pkexec';

/**
 * Does pacman own the copy of Artemis that is running — as *Artemis*?
 *
 * The question every other Linux answer follows from. `pacman -Qo` on the
 * executable is the authority: it answers for the file rather than for the
 * machine, so an AppImage on an Arch box says no and a `.pacman` install says
 * yes wherever it was put.
 *
 * The package it names has to be ours, and that is not pedantry. On Arch
 * nearly every binary belongs to some package — `/usr/bin/node` belongs to
 * `nodejs` — so "pacman owns this file" is very nearly "this is Arch", and
 * acting on it would have Artemis offer to `pacman -U` its own release over
 * whatever else happened to be running it. Only a copy that pacman knows by
 * the app's own name is a copy this release can replace.
 *
 * Asked once and remembered: it cannot change under a running process, and
 * `supported()` is called from the menu. Synchronous because its callers are,
 * and cheap enough to be — one `pacman -Qo`, once per launch, behind an
 * `existsSync` that skips it entirely on every machine without pacman.
 */
let pacmanOwnership: boolean | null = null;
export function ownedByPacman(): boolean {
  if (pacmanOwnership !== null) return pacmanOwnership;
  pacmanOwnership = false;
  if (process.platform === 'linux' && existsSync(PACMAN_BIN)) {
    try {
      // `/opt/Artemis/artemis is owned by Artemis 2.5.0-1`
      const owner = execFileSync(PACMAN_BIN, ['-Qo', process.execPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      });
      pacmanOwnership = new RegExp(`\\bis owned by ${APP_NAME} `, 'i').test(owner);
    } catch {
      // Not owned, or pacman could not say: either way, not ours to replace.
    }
  }
  return pacmanOwnership;
}

/** Only for the tests, which have to ask on more than one imagined machine. */
export function forgetPacmanOwnership(): void {
  pacmanOwnership = null;
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { userDataDir, broadcast } = options;
  const settingsPath = join(userDataDir, 'update-settings.json');
  const pendingDir = join(userDataDir, PENDING_DIR_NAME);
  /** The parked Windows installer or Arch package behind a `ready` state, if any. */
  let pendingInstaller: string | null = null;

  let current: UpdateState = IDLE;
  /** The feed behind an `available` offer; cleared whenever the offer is. */
  let offered: UpdateFeed | null = null;
  let installing = false;
  /** A check is in flight. Serialises the timer's against the menu's. */
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /**
   * Stable until the renderer says otherwise, which it does at startup and on
   * every change. The main process persists no preferences of its own, so this
   * resets on each launch and is told again — which is also why an unreachable
   * renderer degrades to stable rather than to something surprising.
   */
  let channel: UpdateChannel = 'stable';

  function setState(next: UpdateState): UpdateState {
    current = next;
    broadcast(next);
    return next;
  }

  /**
   * Publish a reading of the install in flight.
   *
   * Ignored unless the phase is still `working`, which is what keeps a chunk
   * that lands late — an aborted transfer's last callback, a hash finishing
   * after the swap failed — from overwriting an error the user is reading with
   * a progress bar for work that is no longer happening.
   */
  function report(progress: UpdateProgress): void {
    if (current.phase !== 'working') return;
    setState({ ...current, progress });
  }

  /* ----------------------------------------------------------------------- */
  /* Dismissal persistence                                                   */
  /* ----------------------------------------------------------------------- */

  async function readDismissed(): Promise<string | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
      const value = (parsed as { dismissedVersion?: unknown }).dismissedVersion;
      return typeof value === 'string' ? value : null;
    } catch {
      return null; // No file yet, or unreadable — both mean "nothing dismissed".
    }
  }

  async function writeDismissed(version: string): Promise<void> {
    try {
      await writeFile(settingsPath, `${JSON.stringify({ dismissedVersion: version }, null, 2)}\n`);
    } catch (error) {
      // Losing a dismissal re-shows a banner; not worth surfacing beyond a log.
      log.warn('Could not persist the dismissed version.', error);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The periodic check                                                      */
  /* ----------------------------------------------------------------------- */

  /**
   * Is there anything a check could lead to?
   *
   * The same conditions `start()` refuses to run under, named once so the
   * menu's answer and the timer's silence cannot drift apart. A check that
   * cannot end in an install is not worth performing: it would read the feed,
   * find a newer version, offer it, and fail at the install.
   *
   * Deliberately coarser than {@link installTarget}: this asks whether the
   * *platform* has an install mechanism, not whether this particular copy can
   * use it. A translocated or read-only mac bundle still checks, still gets
   * offered a version, and is told at the install — with the releases page
   * attached — that it cannot swap itself. That is a better answer than never
   * checking and never saying why.
   *
   * Linux is the case where the two agree: there is no mechanism at all, so
   * there is nothing to check for and no network request is made.
   */
  function supported(): boolean {
    if (!app.isPackaged) return false;
    if (process.platform === 'linux') return ownedByPacman();
    return process.platform === 'darwin' || process.platform === 'win32';
  }

  /**
   * Which tag to read the feed from.
   *
   * Returns `''` for stable, which `fetchAsset` understands as "the
   * /releases/latest path" — no API call, one fewer thing to fail. Beta asks
   * the API and falls back to the same empty string when it cannot: an
   * unreachable API should degrade to stable behaviour, not to no updates.
   */
  async function tagToCheck(): Promise<string> {
    if (channel === 'stable') return '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RELEASES_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(RELEASES_API, {
          signal: controller.signal,
          headers: { accept: 'application/vnd.github+json' },
        });
        if (!response.ok) throw new Error(`releases API answered ${response.status}`);
        const releases = (await response.json()) as ReleaseSummary[];
        return tagForChannel('beta', Array.isArray(releases) ? releases : []);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      log.debug('Could not list releases for the beta channel; falling back to latest.', error);
      return '';
    }
  }

  /**
   * Read the feed for the channel this installation is on.
   *
   * Throws when it could not be reached and answers `null` when what came back
   * did not parse. Extracted from `check` when the install grew a read of its
   * own: the feed's name, its deadline and the temp directory it lands in are
   * one decision, and two copies of it would be two things to keep in step.
   */
  async function readFeed(): Promise<UpdateFeed | null> {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-update-check-'));
    try {
      const file = await fetchAsset(feedName(), await tagToCheck(), dir, FEED_FETCH_TIMEOUT_MS);
      return parseUpdateFeed(await readFile(file, 'utf8'), artifactExtension());
    } finally {
      // Left as a `.catch`, like the staging sweep below and for a sharper
      // reason: this `finally` runs after the answer is already in hand, so a
      // throw from it replaces a good feed with a failure the caller can only
      // read as "unreachable". A check that reached the feed must not be able
      // to report otherwise because a temp directory outlived it, which is
      // precisely what an unconditional `/bin/rm` did to Windows.
      await removeTree(dir).catch((error: unknown) => {
        log.warn('Could not clear the update check directory.', error);
      });
    }
  }

  /**
   * May a check write what it finds to the state?
   *
   * `idle` and `available` both yes, and `available` is the one that changed.
   * A standing offer used to turn every later check around at the door — the
   * answer was the version already on the card — so a machine that saw 1.10.1
   * went on being told 1.10.1 long after 1.11.0 shipped, and the only way out
   * was to dismiss the card. An offer is a snapshot of one moment; a check is
   * how that moment is brought up to date, whether a person asked for it or
   * the timer did.
   *
   * `error` is manual-only, and stays that way: a failure is worth leaving on
   * screen until someone asks again, which is the difference between a state
   * the user is reading and one the timer is free to clear.
   *
   * `working`, `ready` and `restarting` are nobody's to write. Bytes are
   * moving, or a bundle is already swapped on disk waiting for a relaunch, and
   * neither can be re-pointed at a different version from here.
   *
   * Asked twice per check — before the feed is read and again before anything
   * is written — because the read is a network round trip with a thirty-second
   * deadline, which is ample time for the user to click Update on the very card
   * being re-read. Without the second ask, a check that started while the card
   * was up would land on top of a download in flight and put the offer back.
   */
  function mayWrite(manual: boolean): boolean {
    if (installing) return false;
    if (current.phase === 'idle' || current.phase === 'available') return true;
    return manual && current.phase === 'error';
  }

  async function check(options: { readonly manual: boolean }): Promise<CheckOutcome> {
    if (checking) return { kind: 'busy' };
    if (!mayWrite(options.manual)) return { kind: 'busy' };
    if (!supported()) return { kind: 'unsupported' };

    checking = true;
    try {
      let feed: UpdateFeed | null = null;
      try {
        feed = await readFeed();
      } catch (error) {
        // No gh, no network, no access: all mean "no banner today", not an error
        // surface. The manual path (the releases page) always remains.
        log.debug('Update check did not reach the feed.', error);
        return { kind: 'unreachable' };
      }
      if (feed === null) {
        log.warn('The update feed did not parse; staying quiet.');
        return { kind: 'unreachable' };
      }
      // Both failures above return before touching the state, which is what
      // makes re-reading over a standing offer safe: a check that cannot reach
      // the feed leaves the card exactly as it found it. The offer is only ever
      // replaced by a better answer, never by the absence of one.
      //
      // A dismissal silences the timer, not the person asking: choosing to
      // check is the opposite of having declined, and re-offering is the only
      // way back to a version dismissed by accident.
      const dismissed = options.manual ? null : await readDismissed();
      const decision = decideOffer({
        feedVersion: feed.version,
        currentVersion: app.getVersion(),
        dismissedVersion: dismissed,
      });
      // Everything above this line only read. The state may have moved while
      // the feed was in flight, so the right to write it is asked for again.
      if (!mayWrite(options.manual)) return { kind: 'busy' };
      if (decision !== 'offer') {
        // `withdraw`: the feed lists nothing newer than what is running, so a
        // card that is up is offering a release that is gone — pulled after it
        // was published, or a channel that moved back under it — and it comes
        // down rather than standing there offering to fetch nothing.
        //
        // `silence` leaves the screen alone, deliberately. Its causes are a
        // version the user declined and a feed too malformed to reason about,
        // and neither is grounds for taking back an offer already made.
        if (decision === 'withdraw' && current.phase === 'available') {
          log.info(
            `The offer of ${current.version ?? '?'} is no longer in the feed; withdrawing it.`,
          );
          offered = null;
          setState(IDLE);
        }
        return { kind: 'current' };
      }
      offered = feed;
      log.info(`Update available: ${feed.version} (running ${app.getVersion()}).`);
      setState({
        phase: 'available',
        version: feed.version,
        message: null,
        releaseUrl: null,
        progress: null,
      });
      return { kind: 'offered', version: feed.version };
    } finally {
      checking = false;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Install                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * What an install would actually replace on this machine, or null when
   * nothing here can be updated in place.
   *
   * The null cases are the ones worth naming: a dev build (the "installed app"
   * is the repository checkout, and a check could only ever offer a downgrade),
   * a mac bundle in a read-only or Gatekeeper-translocated location, and Linux
   * — where Artemis ships as pacman, deb and AppImage, and a package manager's
   * install is the package manager's business.
   */
  function installTarget(): InstallTarget | null {
    if (!app.isPackaged) return null;
    if (process.platform === 'win32') {
      // The NSIS installer replaces the install wherever it is — including
      // files that were just in use — so a packaged build is all it takes.
      // Nothing to probe for writability: the installer elevates if it must.
      return { kind: 'windows-installer' };
    }
    if (process.platform === 'linux') {
      // Nothing to probe for writability: pacman runs as root and replaces
      // whatever it owns. Whether it owns *this* copy is the whole question,
      // and `ownedByPacman` is it.
      return ownedByPacman() ? { kind: 'pacman-package' } : null;
    }
    if (process.platform !== 'darwin') return null;
    // …/Artemis.app/Contents/MacOS/Artemis → …/Artemis.app
    const bundle = resolve(process.execPath, '..', '..', '..');
    if (!bundle.endsWith('.app')) return null;
    if (bundle.includes('/AppTranslocation/')) return null;
    try {
      accessSync(dirname(bundle), fsConstants.W_OK);
    } catch {
      return null;
    }
    return { kind: 'mac-bundle', bundle };
  }

  /**
   * Re-read the feed at the moment of the install and answer with whichever
   * release should actually be fetched.
   *
   * The offer and the click are two different moments, and the gap between them
   * is not theoretical: the card sits at the foot of the sidebar until someone
   * deals with it, which can be days. Without this, a machine that was offered
   * 1.10.1 downloaded 1.10.1 forever — including after 1.11.0 shipped, because
   * the offer had already been made and nothing ever revisited it. The user who
   * left the notice up longest was the one handed the most out-of-date build.
   *
   * A feed that cannot be read leaves the offer standing. The re-read is an
   * improvement on the offer, never a precondition for it, and a transient 5xx
   * between a click and a download should not become an error the user has to
   * click through — the offer was good enough a moment ago and is good enough
   * now.
   *
   * Strictly newer, so this only ever moves forward. An older feed than the
   * offer means the channel moved backwards under it (a yanked release, a beta
   * user switched to stable), and the download failing on a release that is
   * gone is a better answer than quietly fetching something behind what was
   * agreed to.
   */
  async function supersede(offer: UpdateFeed): Promise<UpdateFeed> {
    let latest: UpdateFeed | null = null;
    try {
      latest = await readFeed();
    } catch (error) {
      log.debug('Could not re-read the feed before installing; the offer stands.', error);
      return offer;
    }
    return feedToInstall(offer, latest);
  }

  async function runInstall(offer: UpdateFeed, target: InstallTarget): Promise<void> {
    const staging = await mkdtemp(join(tmpdir(), 'artemis-update-'));
    /*
     * Every step announces itself before it starts and counts while it runs.
     * The announcement matters as much as the count: `unpacking` cannot report
     * bytes, and a surface that says what it is doing is not frozen even when
     * the bar cannot move.
     */
    const step = (next: UpdateStep): void => {
      report({ step: next, transferred: null, total: null });
    };
    const counted = (next: UpdateStep): ((transferred: number, total: number | null) => void) => {
      const emit = throttleProgress((progress) => {
        report(progress);
      });
      return (transferred, total) => {
        emit({ step: next, transferred, total });
      };
    };

    try {
      step('checking');
      const feed = await supersede(offer);
      if (feed.version !== offer.version) {
        log.info(
          `The offer of ${offer.version} was superseded by ${feed.version} before the download began.`,
        );
        // The card names the version it is fetching, so it has to change with
        // it — before the first byte, not after the swap. `offered` moves too:
        // it is what a dismissal is checked against, and what a second click
        // would install.
        offered = feed;
        setState({ ...current, version: feed.version });
      }

      step('downloading');
      const artifact = await fetchAsset(
        feed.artifactPath,
        `v${feed.version}`,
        staging,
        ZIP_FETCH_TIMEOUT_MS,
        counted('downloading'),
      );

      step('verifying');
      const digest = await sha512Of(artifact, counted('verifying'));
      if (digest !== feed.sha512) {
        throw new Error('the downloaded artifact did not match the published checksum');
      }

      if (target.kind === 'windows-installer' || target.kind === 'pacman-package') {
        step('installing');
        /*
         * "Installing" here means parking, and the word is still honest: from
         * the user's side the install is done and waiting on a restart, which
         * is exactly what `ready` means on macOS too. What differs is who does
         * the replacing — a running `.exe` cannot be renamed over itself, so
         * the setup program does it, and it cannot run until Artemis quits;
         * on Arch it is pacman, which needs root and therefore a moment when
         * the user is present to grant it.
         *
         * The file has to outlive this staging directory, which the `finally`
         * below removes: `ready` can stand for days before the restart click
         * hands it over. Copied rather than renamed because the temp
         * directory is very often another filesystem.
         */
        await rm(pendingDir, { recursive: true, force: true });
        await mkdir(pendingDir, { recursive: true });
        const parked = join(pendingDir, basename(artifact));
        await copyFile(artifact, parked);
        pendingInstaller = parked;
      } else {
        step('unpacking');
        const extracted = join(staging, 'extracted');
        await execFileAsync('/usr/bin/ditto', ['-x', '-k', artifact, extracted], {
          timeout: 5 * 60 * 1000,
        });
        const entries = await readdir(extracted);
        const appName = entries.find((entry) => entry.endsWith('.app'));
        if (appName === undefined) throw new Error('the archive did not contain an app bundle');
        const newBundle = join(extracted, appName);

        step('installing');

        // The swap. Two renames on one volume; the first is undone if the
        // second cannot happen. From here on the failure modes are narrow and
        // the running process keeps executing fine from its renamed bundle —
        // open files follow the inode, not the path.
        const parked = `${target.bundle}.old-${process.pid}`;
        await rename(target.bundle, parked);
        try {
          await rename(newBundle, target.bundle);
        } catch (error) {
          await rename(parked, target.bundle);
          throw error;
        }
      }

      // Park. The new version is on disk and the old one is what is running —
      // a state that is entirely fine to stay in. On macOS quitting normally
      // from here launches into the update anyway, because the bundle has
      // already been swapped; on Windows the parked installer simply waits, and
      // the next check finds the same release still newer and offers it again.
      // Either way the relaunch belongs to the user's click on the banner
      // (updates.restart), never to this code path.
      setState({
        phase: 'ready',
        version: feed.version,
        message: null,
        releaseUrl: null,
        progress: null,
      });
      log.info(`Updated to ${feed.version} on disk; waiting for the user to restart.`);
    } finally {
      // The staging tree holds the extracted bundle, asar and all — see
      // `removeTree`. Left as a `.catch`: the install itself has either
      // succeeded or reported, and neither outcome changes over a temp file.
      await removeTree(staging).catch((error: unknown) => {
        log.warn('Could not clear the update staging directory.', error);
      });
    }
  }

  /**
   * Hand the verified package to pacman, and relaunch into it.
   *
   * `pkexec` rather than a terminal: this is a click in a window, and the
   * password belongs in the session's own authentication dialog. That dialog
   * is drawn by a polkit *agent*, which is a separate thing from the polkit
   * daemon and is not running in every session — a bare Wayland compositor
   * very often has none — and with no agent `pkexec` waits rather than
   * failing. Hence the timeout, and hence the message: by this point the
   * download and the checksum are already done, so what is left for the user
   * is one command against a file that is sitting there, and saying which
   * command and which file is the whole difference between a dead end and an
   * inconvenience.
   *
   * Waited on rather than handed over, unlike Windows: pacman replaces files
   * this process is running from, which is safe — the running inodes survive
   * being unlinked — and being here to hear the exit code is what makes the
   * failure reportable at all.
   */
  async function handToPacman(parked: string): Promise<void> {
    log.info('Installing the update through pacman.');
    try {
      await execFileAsync(PKEXEC_BIN, [PACMAN_BIN, '-U', '--noconfirm', parked], {
        timeout: PACMAN_INSTALL_TIMEOUT_MS,
      });
    } catch (error) {
      log.error('pacman could not install the update; the installed app is untouched.', error);
      setState({
        phase: 'error',
        version: current.version,
        message:
          'Artemis could not ask for the permission pacman needs — the session may have no authentication agent running, or the request was declined. ' +
          `The update is downloaded and verified; install it with:  sudo pacman -U ${parked}`,
        releaseUrl: RELEASES_URL,
        progress: null,
      });
      return;
    }
    log.info('pacman installed the update; relaunching.');
    app.relaunch();
    app.quit();
  }

  /** Remove whatever a previous update parked: bundles on macOS, installers on Windows, packages on Arch. */
  async function sweepLeftovers(): Promise<void> {
    const target = installTarget();
    if (target === null) return;

    if (target.kind === 'windows-installer' || target.kind === 'pacman-package') {
      // Reached on the launch *after* an install, whether the installer ran or
      // the user never restarted — either way this file describes a release
      // that is now either installed or superseded, and the next check
      // downloads whatever it actually needs. Nothing here is a rollback path.
      await rm(pendingDir, { recursive: true, force: true }).catch((error: unknown) => {
        log.warn('Could not clear the pending-update directory.', error);
      });
      return;
    }

    const parent = dirname(target.bundle);
    try {
      for (const entry of await readdir(parent)) {
        if (/\.app\.old-\d+$/.test(entry)) {
          await removeTree(join(parent, entry));
          log.info(`Removed a parked previous version: ${entry}`);
        }
      }
    } catch (error) {
      // Still costs disk space and nothing else. It is reported now because
      // saying nothing is what let this fail on every launch from the updater's
      // first release to 0.5.0 without anyone learning it was failing.
      log.warn('Could not remove a parked previous version.', error);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The surface                                                             */
  /* ----------------------------------------------------------------------- */

  return {
    state: () => current,

    setChannel(next: UpdateChannel): UpdateState {
      // No check is kicked off. Someone toggling a setting has not asked to
      // download anything; the channel decides what the *next* check sees.
      if (next !== channel) log.info(`Update channel is now ${next}.`);
      channel = next;
      return current;
    },

    checkNow: () => check({ manual: true }),

    install(): UpdateState {
      if (current.phase !== 'available' || offered === null || installing) return current;
      const feed = offered;
      const target = installTarget();
      if (target === null) {
        // Nothing here can be installed in place (translocated, an unwritable
        // location, or a platform with no single-file swap). Say so once and
        // hand over the manual path.
        return setState({
          phase: 'error',
          version: feed.version,
          message: 'This copy of Artemis cannot update itself. Download the new version from the releases page and replace the app.',
          releaseUrl: RELEASES_URL,
          progress: null,
        });
      }
      installing = true;
      // Opens on the first step rather than on a bare spinner: the click and a
      // word for what is happening should land in the same frame, because the
      // gap between them is exactly the moment that reads as nothing happening.
      setState({
        phase: 'working',
        version: feed.version,
        message: null,
        releaseUrl: null,
        progress: { step: 'checking', transferred: null, total: null },
      });
      void runInstall(feed, target)
        .catch((error: unknown) => {
          log.error('Update failed; the installed app is untouched.', error);
          setState({
            phase: 'error',
            // `current`, not the offer this started from: the re-read may have
            // moved the install onto a newer release, and the error belongs to
            // the version that was actually being fetched.
            version: current.version,
            message: 'The update could not be installed. The app you are running is untouched — try again later, or download it from the releases page.',
            releaseUrl: RELEASES_URL,
            progress: null,
          });
        })
        .finally(() => {
          installing = false;
        });
      return current;
    },

    restart(): UpdateState {
      if (current.phase !== 'ready') return current;
      setState({
        phase: 'restarting',
        version: current.version,
        message: null,
        releaseUrl: null,
        progress: null,
      });
      if (process.platform === 'win32') {
        const installer = pendingInstaller;
        if (installer === null) {
          // `ready` with nothing parked should be unreachable — the state is
          // only ever set after the copy succeeds — but quitting into nothing
          // would leave the user with no app and no installer. Idle is the
          // honest answer: the next check offers the release again.
          log.warn('Ready to restart, but no installer was parked; standing down.');
          return setState(IDLE);
        }
        log.info('Handing over to the installer; it relaunches Artemis when it is done.');
        // Detached and unref'd, so quitting Artemis does not take the installer
        // down with it — the whole point is that it runs *after* this process
        // is gone and its files are no longer in use. `/S` installs silently;
        // `--force-run` is NSIS's flag for relaunching the app when it is done,
        // which is what makes this a restart rather than a quit.
        spawn(installer, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
        app.quit();
        return current;
      }
      if (process.platform === 'linux') {
        const parked = pendingInstaller;
        if (parked === null) {
          log.warn('Ready to restart, but no package was parked; standing down.');
          return setState(IDLE);
        }
        void handToPacman(parked);
        return current;
      }
      log.info('Restarting into the installed update at the user\'s request.');
      // The parked old bundle is swept by the next launch's start(), not here:
      // this process is still running out of it.
      app.relaunch();
      app.quit();
      return current;
    },

    async dismiss(version: string): Promise<UpdateState> {
      // Only a decision that is still open can be dismissed. `ready` is
      // deliberately not dismissible: the update is already on disk, so the
      // honest states are "restart now" and "it arrives on your next launch" —
      // hiding the banner cannot un-install anything.
      //
      // The same condition gates the *persistence*, and used not to: `version`
      // is a renderer-supplied string, and writing it down unconditionally let
      // anything that could speak this channel pre-dismiss a release that was
      // never offered — silencing a future update banner. A version that
      // matches nothing on screen is a no-op, not a record.
      if (current.version === version && (current.phase === 'available' || current.phase === 'error')) {
        await writeDismissed(version);
        offered = null;
        return setState(IDLE);
      }
      return current;
    },

    start(): void {
      if (timer !== null) return;
      // Both refusals are `supported()`; they are spelled out separately here
      // only because the log line is the one place the two are worth telling
      // apart. In dev the "installed app" is the repo checkout: nothing to
      // update, and a check could only ever offer a downgrade to a release.
      // On Linux there is no single-file install to replace — pacman, deb and
      // AppImage all install differently and two of them belong to a package
      // manager — so no card ever appears and the About pane says why.
      if (!app.isPackaged) {
        log.debug('Updater disabled: not a packaged build.');
        return;
      }
      if (!supported()) {
        log.debug(`Updater disabled: nothing on ${process.platform} for it to install.`);
        return;
      }
      stopped = false;
      void sweepLeftovers();
      const schedule = (delay: number): void => {
        if (stopped) return;
        timer = setTimeout(() => {
          void check({ manual: false }).finally(() => schedule(CHECK_EVERY_MS));
        }, delay);
        timer.unref?.();
      };
      schedule(FIRST_CHECK_MS);
    },

    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
