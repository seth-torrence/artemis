import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAttachment } from './attachments.js';

describe('readAttachment', () => {
  it('reads an image by extension and a file otherwise, relative to cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-attach-'));
    await writeFile(join(dir, 'shot.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, 'notes.md'), '# hi');
    await writeFile(join(dir, 'blob.bin'), Buffer.from([1, 2, 3]));

    const image = await readAttachment('shot.PNG', dir);
    expect(image.ok && image.attachment).toMatchObject({ kind: 'image', mediaType: 'image/png', name: 'shot.PNG' });
    expect(image.ok && image.attachment.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));

    const file = await readAttachment('notes.md', dir);
    expect(file.ok && file.attachment).toMatchObject({ kind: 'file', name: 'notes.md', mediaType: 'text/markdown' });

    const blob = await readAttachment('blob.bin', dir);
    expect(blob.ok && blob.attachment).toMatchObject({ kind: 'file', name: 'blob.bin' });
    expect(blob.ok && 'mediaType' in blob.attachment).toBe(false);
  });

  it('explains a missing path or a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-attach-'));
    const missing = await readAttachment('nope.png', dir);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toMatch(/does not exist/);
    const directory = await readAttachment('.', dir);
    expect(!directory.ok && directory.reason).toMatch(/not a file/);
  });
});

describe('a path the way a person types it', () => {
  it('expands ~ to the home directory', async () => {
    // `/attach ~/shot.png` resolved under the *working directory* — as a
    // folder literally named `~` — and reported the file missing. Every shell
    // a person has ever typed that into expanded it.
    const home = await mkdtemp(join(tmpdir(), 'artemis-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'artemis-cwd-'));
    await writeFile(join(home, 'notes.md'), '# hi');

    const result = await readAttachment('~/notes.md', cwd, { home });

    expect(result.ok && result.attachment).toMatchObject({ kind: 'file', name: 'notes.md' });
  });
});
