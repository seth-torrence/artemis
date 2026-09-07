/**
 * Filesystem paths, as the renderer is allowed to know them.
 * ============================================================================
 *
 * The renderer has no `node:path`, no `fs`, and — importantly — no `$HOME`.
 * Everything here is therefore *display* logic plus one shape check, and none
 * of it is authoritative: the main process validates a path properly before any
 * run touches it (see `main/validate.ts`, which is the real gate). What this
 * module buys is a sidebar that reads like a person wrote it, and a text field
 * that rejects `src/foo` before it costs the user a round trip.
 *
 * ## Why `inferHomeDirectory` is a heuristic and why that is acceptable
 *
 * Tilde-collapsing `/Users/ada/code/artemis` → `~/code/artemis` needs the home
 * directory, and there is no IPC channel that reports one. Rather than invent
 * a channel for a cosmetic gain, the home directory is *inferred* from the
 * paths already on screen: whichever `/Users/<name>` (or `/home/<name>`, or
 * `C:\Users\<name>`) prefix is most common across the known session
 * directories is treated as home.
 *
 * That can be wrong — a machine with two user directories in play, an unusual
 * layout — so nothing depends on it being right. Every place a shortened path
 * is rendered also carries the full path in its `title`, so a bad guess costs
 * a hover and never hides information.
 */

import { compareFolderNames as compareFolderNamesShared } from '@rx-artemis/transcript';

export type Platform = 'darwin' | 'win32' | 'linux';

/** The separator paths on this platform are built from. */
export function separatorFor(platform: Platform): string {
  return platform === 'win32' ? '\\' : '/';
}

/**
 * The platform whose path rules apply to the pane's working directories.
 *
 * A local bridge's paths are this window's own, spelled the way its OS spells
 * them. A remote bridge's directories live on the *serving* machine, which is
 * POSIX by the server's own contract — its validators accept nothing else —
 * so validating a typed path there must not ask how this window's OS spells
 * an absolute path: a Windows window connected to a server would reject
 * `/srv/work`, the only shape the far side will take. One function, so the
 * next component that needs the rule cannot fork it.
 */
export function pathPlatformFor(bridgeMode: string, platform: Platform): Platform {
  return bridgeMode === 'remote' ? 'linux' : platform;
}

/**
 * Is this an absolute path, on the given platform?
 *
 * Mirrors what `node:path.isAbsolute` would say, which is what the main process
 * actually enforces — for the machine the paths belong to, which in remote
 * bridge mode is the serving one: pass the platform through
 * {@link pathPlatformFor} rather than reading the window's own. Deliberately
 * platform-specific rather than "starts with a
 * slash or has a drive letter": telling a macOS user that `C:\src` is fine and
 * then having the backend reject it is worse than rejecting it here.
 */
export function isAbsolutePath(path: string, platform: Platform): boolean {
  const value = path.trim();
  if (value.length === 0 || value.includes('\u0000')) return false;
  if (platform === 'win32') {
    // `C:\x`, `C:/x`, or a UNC share `\\server\share`.
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]/.test(value);
  }
  return value.startsWith('/');
}

/** The sentence shown under a rejected path. Names the platform's rule. */
export function absolutePathHint(platform: Platform): string {
  return platform === 'win32'
    ? 'Must be an absolute path — a drive letter (C:\\Users\\you\\project) or a UNC share (\\\\server\\share).'
    : 'Must be an absolute path, starting with “/”. Relative paths and “~” are not expanded here.';
}

/** Home-directory shapes, per platform. Only ever used for display. */
const HOME_PATTERNS: Record<Platform, RegExp> = {
  darwin: /^(\/Users\/[^/]+)(?:\/|$)/,
  linux: /^(\/home\/[^/]+)(?:\/|$)/,
  win32: /^([A-Za-z]:\\Users\\[^\\]+)(?:\\|$)/,
};

/**
 * Guess the user's home directory from the paths we already have.
 *
 * Returns `undefined` when nothing looks like a home directory, in which case
 * callers simply render the full path — the degraded case is "a slightly longer
 * label", which is why guessing is safe here at all.
 */
export function inferHomeDirectory(
  paths: Iterable<string>,
  platform: Platform,
): string | undefined {
  const pattern = HOME_PATTERNS[platform];
  const counts = new Map<string, number>();
  for (const path of paths) {
    const match = pattern.exec(path);
    const home = match?.[1];
    if (home === undefined) continue;
    counts.set(home, (counts.get(home) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [home, count] of counts) {
    // Strictly greater, so the first-inserted candidate wins a tie and the
    // result is stable across renders rather than flickering between two homes.
    if (count > bestCount) {
      best = home;
      bestCount = count;
    }
  }
  return best;
}

/** `/Users/ada/code` → `~/code`, when `home` is a prefix. Otherwise unchanged. */
export function collapseHome(path: string, home: string | undefined, platform: Platform): string {
  if (!home || home.length === 0) return path;
  const separator = separatorFor(platform);
  if (path === home) return '~';
  if (path.startsWith(home + separator)) return `~${path.slice(home.length)}`;
  return path;
}

export interface ShortenOptions {
  readonly home?: string | undefined;
  readonly platform?: Platform;
  /** Target length. Not a hard cap — the last segment is never fully eaten. */
  readonly max?: number;
}

/**
 * A readable label for a project directory.
 *
 * Collapses the home directory, then elides the *middle* rather than either
 * end. Both ends carry meaning in a session sidebar: the head says which tree
 * ("~", "/opt", a volume) and the tail is the project's actual name, which is
 * what the user is scanning for. Truncating from the right — the default a
 * `truncate` class would give — throws away exactly the part that identifies
 * the row.
 */
export function shortenPath(path: string, options: ShortenOptions = {}): string {
  const platform = options.platform ?? 'darwin';
  const max = options.max ?? 32;
  const separator = separatorFor(platform);

  const collapsed = collapseHome(path.trim(), options.home, platform);
  if (collapsed.length <= max) return collapsed;

  const leading = collapsed.startsWith(separator) ? separator : '';
  const segments = collapsed.slice(leading.length).split(separator).filter(Boolean);
  if (segments.length === 0) return collapsed;

  const last = segments[segments.length - 1] as string;

  // Head + … + last two segments, e.g. `~/…/apps/desktop`.
  if (segments.length > 3) {
    const head = segments[0] as string;
    const tail = segments.slice(-2).join(separator);
    const elided = `${leading}${head}${separator}…${separator}${tail}`;
    if (elided.length <= max) return elided;
  }

  // Still too long: drop the head entirely.
  if (segments.length > 2) {
    const tail = segments.slice(-2).join(separator);
    const elided = `…${separator}${tail}`;
    if (elided.length <= max) return elided;
  }

  // One segment, and it is the name of the thing. Clip its front, not its
  // back — `…ktop-app` still identifies a project; `desktop-…` does not.
  if (last.length > max) return `…${last.slice(last.length - (max - 1))}`;
  return `…${separator}${last}`;
}

/** Last segment of a path, for a compact chip. Handles both separators. */
export function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

/**
 * Order a set of directories the way a person looks for one: by folder name.
 *
 * By *name*, not by path, because the name is what the row is labelled with and
 * what the user is scanning for. Sorting on the full path would group by
 * whatever tree a project happens to live in — every `~/dev/...` before every
 * `~/work/...` — which is an order the user cannot predict from the labels they
 * can see. The path breaks ties, so two `desktop` folders in different trees sit
 * together and in a stable order rather than swapping places between renders.
 *
 * `localeCompare` with `sensitivity: 'base'` and `numeric`, so `Artemis` sorts
 * next to `artemis` rather than in a separate uppercase block, and `run-2` comes
 * before `run-10`.
 *
 * Returns a new array; the input is left alone. Callers hold these lists in a
 * store where identity decides re-renders, so sorting in place would be a
 * mutation of state nobody asked for.
 */
export function sortFoldersByName(paths: readonly string[]): readonly string[] {
  return [...paths].sort(compareFolderNames);
}

/**
 * The comparator behind {@link sortFoldersByName}, for callers sorting objects
 * rather than bare paths.
 *
 * Shared rather than reimplemented: the sidebar's project headings and every
 * directory list in the app are the same question asked in two places, and two
 * copies of "by name, then by path, base sensitivity, numeric" would be two
 * chances for the sidebar to order itself differently from the picker that
 * chooses what goes in it. The definition itself lives in
 * `@rx-artemis/transcript`, where the terminal UI's rail reads it too.
 */
export function compareFolderNames(a: string, b: string): number {
  return compareFolderNamesShared(a, b);
}
