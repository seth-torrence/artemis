/**
 * Which written file gets a tile, and which stays a diff.
 *
 * The stakes are asymmetric and the tests are written around that asymmetry. A
 * missed artifact costs one click — the Preview button is still on the row. A
 * *false* artifact hides a source diff behind a tile and, because the first one
 * of a run opens the pane by itself, takes over half the window during ordinary
 * work. So the negative cases below are the point of the file: `README.md`, the
 * fixture, the template partial, the icon in `assets/`.
 */

import { describe, expect, it } from 'vitest';

import { detectArtifact } from './artifact';
import type { DiffRow, FileEdit } from '@rx-artemis/transcript';

/** A whole-file write of `content` to `path`. */
function wrote(path: string, extension: string, content: string): FileEdit {
  const rows: DiffRow[] = content.split('\n').map((text, i) => ({
    kind: 'add',
    text,
    newNo: i + 1,
  }));
  return { path, extension, rows, added: rows.length, removed: 0, truncated: false, whole: true };
}

/** An edit to an existing file: context rows either side of one addition. */
function edited(path: string, extension: string): FileEdit {
  const rows: DiffRow[] = [
    { kind: 'ctx', text: '  <body>', oldNo: 1, newNo: 1 },
    { kind: 'add', text: '  <p>new</p>', newNo: 2 },
  ];
  return { path, extension, rows, added: 1, removed: 0, truncated: false, whole: false };
}

const PAGE = '<!doctype html>\n<html lang="en">\n<body>hi</body>\n</html>';

describe('detectArtifact', () => {
  it('recognises a page written outside the working directory', () => {
    const found = detectArtifact(wrote('/tmp/report.html', 'html', PAGE), '/home/dev/app', 'linux');
    expect(found).toMatchObject({
      path: '/tmp/report.html',
      title: 'report.html',
      kind: 'page',
      fresh: true,
    });
  });

  it('reports a size for the tile to show', () => {
    const found = detectArtifact(wrote('/tmp/r.html', 'html', PAGE), '/home/dev/app', 'linux');
    expect(found?.bytes).toBe(PAGE.length + 1);
  });

  /*
   * The directory test. Everything under the project is source until proven
   * otherwise — see the module header for why this errs the way it does.
   */
  describe('inside the working directory', () => {
    it('refuses a page written into the project', () => {
      expect(detectArtifact(wrote('/app/index.html', 'html', PAGE), '/app', 'linux')).toBeNull();
    });

    it('refuses a README, which is the case this rule exists for', () => {
      expect(detectArtifact(wrote('/app/README.md', 'md', '# App\n'), '/app', 'linux')).toBeNull();
    });

    it('refuses a page nested deep in the project', () => {
      expect(
        detectArtifact(wrote('/app/test/fixtures/page.html', 'html', PAGE), '/app', 'linux'),
      ).toBeNull();
    });

    /*
     * The exception, and the reason the rule is about *where output goes*
     * rather than about the project boundary: "build me a dashboard" lands in
     * `out/` inside the repo, and that is an artifact by every meaning of the
     * word.
     */
    it('accepts a page written into an output directory in the project', () => {
      expect(detectArtifact(wrote('/app/out/report.html', 'html', PAGE), '/app', 'linux'))
        .not.toBeNull();
    });

    it('accepts the other conventional output directories', () => {
      for (const dir of ['dist', 'build', 'tmp', 'scratch', 'artifacts', 'generated', 'coverage']) {
        expect(
          detectArtifact(wrote(`/app/${dir}/r.html`, 'html', PAGE), '/app', 'linux'),
          `${dir} should count as output`,
        ).not.toBeNull();
      }
    });

    it('matches an output directory at any depth, as a monorepo has', () => {
      expect(
        detectArtifact(wrote('/app/packages/web/dist/r.html', 'html', PAGE), '/app', 'linux'),
      ).not.toBeNull();
    });

    it('does not treat a file merely named like one as being in one', () => {
      // `out.html` is a file called out, not a file in `out/`.
      expect(detectArtifact(wrote('/app/out.html', 'html', PAGE), '/app', 'linux')).toBeNull();
    });

    it('leaves the ambiguous directories alone', () => {
      // Generated pages do land in these, but so does hand-written source, and
      // the inclusive mistake is the expensive one.
      for (const dir of ['public', 'docs', 'static', 'assets', 'src']) {
        expect(
          detectArtifact(wrote(`/app/${dir}/r.html`, 'html', PAGE), '/app', 'linux'),
          `${dir} should stay a diff`,
        ).toBeNull();
      }
    });

    it('is not fooled by a sibling directory sharing a prefix', () => {
      // `/app-notes` is not inside `/app`, and a naive startsWith would say it is.
      expect(
        detectArtifact(wrote('/app-notes/r.html', 'html', PAGE), '/app', 'linux'),
      ).not.toBeNull();
    });

    it('ignores a trailing separator on the working directory', () => {
      expect(detectArtifact(wrote('/app/r.html', 'html', PAGE), '/app/', 'linux')).toBeNull();
    });

    it('folds case where the platform does', () => {
      expect(detectArtifact(wrote('/App/r.html', 'html', PAGE), '/app', 'darwin')).toBeNull();
      expect(detectArtifact(wrote('/App/r.html', 'html', PAGE), '/app', 'linux')).not.toBeNull();
    });

    it('matches across mixed separators on Windows', () => {
      expect(
        detectArtifact(wrote('C:\\src\\app/pages/r.html', 'html', PAGE), 'C:\\src\\app', 'win32'),
      ).toBeNull();
    });
  });

  /*
   * The shape test. A fragment renders as an unstyled sliver, which reads as a
   * broken preview rather than as the partial file it is.
   */
  describe('document shape', () => {
    it('refuses an HTML fragment', () => {
      expect(
        detectArtifact(wrote('/tmp/row.html', 'html', '<div class="row">x</div>'), '/app', 'linux'),
      ).toBeNull();
    });

    it('refuses a template partial', () => {
      expect(
        detectArtifact(wrote('/tmp/nav.html', 'html', '{{#each items}}<li>x</li>{{/each}}'), '/app', 'linux'),
      ).toBeNull();
    });

    it('accepts a page that opens with <html> and no doctype', () => {
      expect(
        detectArtifact(wrote('/tmp/r.html', 'html', '<html>\n<body>hi</body>\n</html>'), '/app', 'linux'),
      ).not.toBeNull();
    });

    it('accepts a page behind a leading comment', () => {
      expect(
        detectArtifact(wrote('/tmp/r.html', 'html', `<!-- generated -->\n${PAGE}`), '/app', 'linux'),
      ).not.toBeNull();
    });

    it('accepts an SVG behind an XML declaration', () => {
      expect(
        detectArtifact(
          wrote('/tmp/c.svg', 'svg', '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>'),
          '/app',
          'linux',
        ),
      ).not.toBeNull();
    });

    it('refuses an SVG fragment', () => {
      expect(
        detectArtifact(wrote('/tmp/c.svg', 'svg', '<g><path d="M0 0"/></g>'), '/app', 'linux'),
      ).toBeNull();
    });

    it('applies no shape test to markdown, which has none to apply', () => {
      expect(
        detectArtifact(wrote('/tmp/notes.md', 'md', 'just a sentence'), '/app', 'linux'),
      ).toMatchObject({ kind: 'markdown' });
    });
  });

  /*
   * An edit is how an artifact is revised. It qualifies, but says so — the
   * caller must not treat "the page you are reading changed" as "a new page
   * arrived", or a session of tweaks would flap the pane open on every one.
   */
  describe('edits', () => {
    it('treats an edit to a qualifying path as an update, not a fresh artifact', () => {
      expect(detectArtifact(edited('/tmp/report.html', 'html'), '/app', 'linux')).toMatchObject({
        path: '/tmp/report.html',
        fresh: false,
      });
    });

    it('reports no size for an edit, whose payload is a fragment', () => {
      expect(detectArtifact(edited('/tmp/report.html', 'html'), '/app', 'linux')?.bytes).toBeUndefined();
    });

    it('still refuses an edit inside the project', () => {
      expect(detectArtifact(edited('/app/index.html', 'html'), '/app', 'linux')).toBeNull();
    });
  });

  describe('everything else', () => {
    it('refuses a call that edited no file', () => {
      expect(detectArtifact(null, '/app', 'linux')).toBeNull();
    });

    it('refuses a file the pane cannot render', () => {
      expect(
        detectArtifact(wrote('/tmp/main.ts', 'ts', 'export const x = 1;'), '/app', 'linux'),
      ).toBeNull();
    });

    it('refuses a relative path with no absolute working directory to resolve it', () => {
      expect(detectArtifact(wrote('out/r.html', 'html', PAGE), 'relative', 'linux')).toBeNull();
    });

    it('resolves a relative path against the working directory before judging it', () => {
      // Both halves in one: resolution happens, and the resolved path is source.
      expect(detectArtifact(wrote('pages/r.html', 'html', PAGE), '/app', 'linux')).toBeNull();
      // The same relative path under an output directory resolves and qualifies.
      expect(detectArtifact(wrote('out/r.html', 'html', PAGE), '/app', 'linux')).toMatchObject({
        path: '/app/out/r.html',
      });
    });
  });
});
