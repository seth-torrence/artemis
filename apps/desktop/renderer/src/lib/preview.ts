/**
 * Which tool calls produced something worth looking at.
 *
 * The transcript already knows how to read a file-editing tool call — see
 * `detectFileEdit`, which turns one into a diff. This is the second question
 * asked of the same parse: is what it wrote a *page*, and if so what absolute
 * path is it at?
 *
 * Framework-free and in `lib/` for the usual reason: path resolution across two
 * platforms is exactly the sort of thing that is quietly wrong for a year, and
 * it is worth testing without mounting a transcript.
 *
 * ## The extension list appears twice, on purpose
 *
 * `main/preview.ts` has the authoritative copy — it is the layer that serves the
 * bytes, and it refuses anything not on its list regardless of what the renderer
 * believes. This copy decides only whether to *offer* the button. A drift
 * between them is therefore a cosmetic bug (an offered preview that fails with a
 * clear sentence), never a hole: the renderer cannot talk the main process into
 * serving something it does not want to serve.
 */

import type { FileEdit } from '@rx-artemis/transcript';
import { isAbsolutePath, separatorFor, type Platform } from './paths';

/** Extensions the preview pane can render. See the note above about the copy. */
const RENDERABLE = new Set(['html', 'htm', 'svg', 'md', 'markdown']);

/**
 * The absolute path of a page this tool call wrote, or `null`.
 *
 * `null` covers three different "no" answers and deliberately does not
 * distinguish them, because the caller does the same thing for all three — draw
 * no button:
 *
 *  - the call did not write a file at all,
 *  - it wrote something that is not a page,
 *  - it named a relative path and `cwd` cannot make it absolute.
 *
 * The third is the interesting one. Tools usually pass absolute paths, but not
 * always, and the main process requires one — so a relative path is resolved
 * against the column's working directory here rather than being sent on to be
 * rejected with a message about a rule the user never broke.
 */
export function previewablePath(
  edit: FileEdit | null,
  cwd: string,
  platform: Platform,
): string | null {
  if (!edit || !RENDERABLE.has(edit.extension)) return null;

  const path = edit.path.trim();
  if (path.length === 0) return null;
  if (isAbsolutePath(path, platform)) return path;

  // `~` is a shell convenience, not a path. The renderer does not know the home
  // directory and must not guess at one — see `inferHomeDirectory`, which only
  // ever guesses for *display*.
  if (path.startsWith('~')) return null;
  if (!isAbsolutePath(cwd, platform)) return null;

  const separator = separatorFor(platform);
  const base = cwd.endsWith(separator) ? cwd.slice(0, -separator.length) : cwd;
  // Only the leading `./` is stripped. Anything more — a `../`, a doubled
  // separator — is left for the main process's own `stat` to resolve or refuse,
  // because a renderer that normalised paths would be a second, weaker copy of
  // the check that actually guards the filesystem.
  const relative = path.startsWith(`.${separator}`) || path.startsWith('./')
    ? path.slice(2)
    : path;
  return `${base}${separator}${relative}`;
}
