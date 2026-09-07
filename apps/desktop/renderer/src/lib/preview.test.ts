/**
 * Deciding whether a tool call produced a page, and where that page is.
 *
 * Two things are pinned here, and the second is the reason this is tested at
 * all. The first is the easy one — only pages get a Preview button. The second
 * is that the path handed to the main process is always absolute, on both
 * platforms, whatever shape the tool named the file in: the validator on the
 * other side rejects anything else, and a button that fails on click is worse
 * than a button that was never drawn.
 */

import { describe, expect, it } from 'vitest';

import type { FileEdit } from '@rx-artemis/transcript';
import { previewablePath } from './preview';

/** A minimal `FileEdit`; only `path` and `extension` are read. */
function edit(path: string, extension: string): FileEdit {
  return { path, extension, rows: [], added: 0, removed: 0, truncated: false, whole: true };
}

describe('previewablePath', () => {
  it('offers a page written to an absolute path', () => {
    expect(previewablePath(edit('/tmp/sales.html', 'html'), '/tmp', 'darwin')).toBe(
      '/tmp/sales.html',
    );
  });

  it('offers .htm and .svg too', () => {
    expect(previewablePath(edit('/a/b.htm', 'htm'), '/a', 'darwin')).toBe('/a/b.htm');
    expect(previewablePath(edit('/a/c.svg', 'svg'), '/a', 'darwin')).toBe('/a/c.svg');
  });

  /*
   * Markdown, which the transcript renders for conversation but which had
   * nowhere to be read from when the agent wrote it to a *file*.
   */
  it('offers markdown, in both spellings', () => {
    expect(previewablePath(edit('/a/README.md', 'md'), '/a', 'darwin')).toBe('/a/README.md');
    expect(previewablePath(edit('/a/notes.markdown', 'markdown'), '/a', 'darwin')).toBe(
      '/a/notes.markdown',
    );
  });

  it('declines anything that is not a page or a document', () => {
    expect(previewablePath(edit('/a/index.ts', 'ts'), '/a', 'darwin')).toBeNull();
    expect(previewablePath(edit('/a/data.json', 'json'), '/a', 'darwin')).toBeNull();
    // No extension at all — `detectFileEdit` reports this as an empty string.
    expect(previewablePath(edit('/a/Makefile', ''), '/a', 'darwin')).toBeNull();
  });

  it('declines when there was no edit', () => {
    expect(previewablePath(null, '/a', 'darwin')).toBeNull();
  });

  /*
   * Resolution. A tool that names a path relative to the working directory is
   * ordinary, and the main process cannot resolve it — it has no idea which
   * column asked.
   */
  it('resolves a relative path against the column working directory', () => {
    expect(previewablePath(edit('out/report.html', 'html'), '/home/dev/app', 'linux')).toBe(
      '/home/dev/app/out/report.html',
    );
  });

  it('strips a leading ./', () => {
    expect(previewablePath(edit('./report.html', 'html'), '/home/dev/app', 'linux')).toBe(
      '/home/dev/app/report.html',
    );
  });

  it('does not double the separator when the cwd ends in one', () => {
    expect(previewablePath(edit('report.html', 'html'), '/home/dev/app/', 'linux')).toBe(
      '/home/dev/app/report.html',
    );
  });

  it('uses the platform separator on Windows', () => {
    expect(previewablePath(edit('out\\report.html', 'html'), 'C:\\src\\app', 'win32')).toBe(
      'C:\\src\\app\\out\\report.html',
    );
    expect(previewablePath(edit('C:\\src\\app\\r.html', 'html'), 'C:\\src', 'win32')).toBe(
      'C:\\src\\app\\r.html',
    );
  });

  it('does not treat a POSIX path as absolute on Windows', () => {
    // It would be resolved against the cwd instead, which is the honest answer:
    // `/tmp/x.html` on Windows is not an absolute path and `isAbsolutePath`
    // says so, so it must not be sent on as one.
    expect(previewablePath(edit('/tmp/x.html', 'html'), 'C:\\src', 'win32')).toBe(
      'C:\\src\\/tmp/x.html',
    );
  });

  it('declines a relative path when the cwd is not absolute either', () => {
    // Nothing to resolve against, and guessing would produce a path that
    // resolves against the main process's own cwd on the far side.
    expect(previewablePath(edit('report.html', 'html'), '', 'darwin')).toBeNull();
    expect(previewablePath(edit('report.html', 'html'), 'relative/dir', 'darwin')).toBeNull();
  });

  it('declines a tilde rather than guessing at a home directory', () => {
    expect(previewablePath(edit('~/report.html', 'html'), '/home/dev', 'linux')).toBeNull();
  });

  it('declines an empty path', () => {
    expect(previewablePath(edit('   ', 'html'), '/a', 'darwin')).toBeNull();
  });
});
