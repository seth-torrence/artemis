/**
 * Staying current, for a copy that was installed rather than checked out.
 *
 * `install.sh` puts a build under one directory and writes a launcher that
 * names that directory in `ARTEMIS_TUI_INSTALL`. That variable is the whole
 * distinction: set, this is an installed copy that can be replaced by running
 * the installer again — a copy of it ships in every build, so the update
 * uses the installer that matches the build; unset, this is a checkout, and
 * updating it is `git pull`.
 *
 * The check is one request to the GitHub releases API, at most once a day,
 * remembered in the same cache as the last plan reading (see `cache.ts`),
 * and only ever a line in the status bar. Nothing is downloaded until the
 * person asks. The request has a short timeout and swallows every failure,
 * because a machine that cannot reach GitHub is not a machine that needs
 * telling so at every launch.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { type ReadingCache } from './cache.js';

export const RELEASES_API = 'https://api.github.com/repos/seth-torrence/artemis/releases/latest';
export const UPDATE_CHECK_KEY = 'latest-release';
/** A day: releases are not that frequent, and the check costs a request. */
export const UPDATE_CHECK_MAX_AGE_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;

/** The version this copy was packaged as, from its own manifest. */
export function currentVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version?: string };
  return pkg.version ?? '0.0.0';
}

/** Where the installer put this copy, or `undefined` for a checkout. */
export function installRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env['ARTEMIS_TUI_INSTALL'];
  return root !== undefined && root.length > 0 ? root : undefined;
}

/**
 * Semantic-version order, enough for release tags: numeric parts compared as
 * numbers, and a prerelease sorts below the release it rehearses.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { readonly parts: number[]; readonly pre: string } => {
    const [core = '', pre = ''] = v.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The latest release's version, or `null` when it cannot be learned. */
export async function latestRelease(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'artemis-tui' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown };
    return typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/**
 * A newer version than `current`, if one has been released — asked at most
 * once a day, the answer remembered in `cache`. `null` means up to date or
 * unknown, which the status line treats the same way: silence.
 */
export async function checkForUpdate(
  current: string,
  cache: ReadingCache,
  options: { readonly fetchImpl?: typeof fetch; readonly now?: number } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now();
  const remembered = cache.get<string>(UPDATE_CHECK_KEY);
  let latest: string | null;
  if (remembered !== undefined && now - remembered.at < UPDATE_CHECK_MAX_AGE_MS) {
    latest = remembered.value;
  } else {
    latest = await latestRelease(options.fetchImpl);
    if (latest !== null) cache.set(UPDATE_CHECK_KEY, latest, now);
  }
  return latest !== null && compareVersions(latest, current) > 0 ? latest : null;
}

/**
 * Replace this copy with the latest release, by running the installer that
 * shipped with it. Returns the exit code to end with; the installer's own
 * output is the report.
 */
export function runUpdate(root: string): number {
  const result = spawnSync('bash', [join(root, 'current', 'install.sh')], { stdio: 'inherit' });
  if (result.error !== undefined) {
    process.stderr.write(`Could not run the installer: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}
