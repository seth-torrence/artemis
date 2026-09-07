/**
 * A path on disk, turned into something a message can carry.
 *
 * The desktop takes attachments from a file picker or a drop; a terminal
 * takes a path. This reads it, decides whether it is an image the providers
 * accept or a file, and produces the protocol's `Attachment` — base64, with
 * the media type the extension implies. Nothing is uploaded anywhere: the
 * adapter stages the bytes into a temporary directory for the provider CLI,
 * exactly as it does for the desktop.
 *
 * Images are recognised by extension against the four media types the
 * protocol allows. Everything else is a file, with a best-guess media type
 * that the protocol marks advisory. A size cap keeps a mistyped path to a
 * disk image from becoming a hundred-megabyte prompt.
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

import type { Attachment, ImageMediaType } from '@rx-artemis/protocol';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_BY_EXTENSION: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const FILE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

export type ReadAttachmentResult =
  | { readonly ok: true; readonly attachment: Attachment; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export interface ReadAttachmentOptions {
  /** What `~` stands for. The real home directory unless a test says otherwise. */
  readonly home?: string;
}

/**
 * `~` is expanded first, because every shell the path was ever typed into
 * expanded it: `/attach ~/shot.png` otherwise looked for a directory literally
 * named `~` under the working directory and reported the file missing.
 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

export async function readAttachment(path: string, cwd: string, options: ReadAttachmentOptions = {}): Promise<ReadAttachmentResult> {
  const full = resolve(cwd, expandHome(path.trim(), options.home ?? homedir()));
  let size: number;
  try {
    const info = await stat(full);
    if (!info.isFile()) return { ok: false, reason: `${full} is not a file.` };
    size = info.size;
  } catch {
    return { ok: false, reason: `${full} does not exist or cannot be read.` };
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `${basename(full)} is ${String(Math.round(size / 1024 / 1024))} MB; the limit is ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.` };
  }

  const data = (await readFile(full)).toString('base64');
  const extension = extname(full).toLowerCase();
  const image = IMAGE_BY_EXTENSION[extension];
  const name = basename(full);
  if (image !== undefined) {
    return { ok: true, path: full, attachment: { kind: 'image', id: randomUUID(), mediaType: image, data, name } };
  }
  const mediaType = FILE_BY_EXTENSION[extension];
  return {
    ok: true,
    path: full,
    attachment: { kind: 'file', id: randomUUID(), name, data, ...(mediaType === undefined ? {} : { mediaType }) },
  };
}
