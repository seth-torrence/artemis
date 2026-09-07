/**
 * The Arch feed, as the release actually writes it.
 *
 * `scripts/linux-update-feed.ts` and `parseUpdateFeed` are two halves of one
 * agreement — three top-level fields, a base64 sha512, and a `path` naming a
 * `.pacman` — held in separate files that are built by different jobs. This
 * pins the shape so a change to either half fails here rather than on a
 * user's machine, where the symptom is silence: an unparseable feed is "no
 * update today", which is exactly what a broken updater looks like.
 */
import { describe, expect, it } from 'vitest';

import { parseUpdateFeed } from './updateFeed.js';

/** Verbatim from a run of `scripts/linux-update-feed.ts` against the 2.5.0 release. */
const FEED = `version: 2.5.0
path: Artemis-2.5.0-x64.pacman
sha512: GWaSJsAjQGiKaMIyynkcU9LhQG6KZcvBaDNEYqF6FMOQjGBFACCmDuNkhygOzPpgAOCjBrWEcRYJ2wgAV27Mmg==
releaseDate: '2026-09-04T17:30:21.888Z'
`;

describe('the Arch update feed', () => {
  it('parses into the version, package and checksum the updater installs', () => {
    expect(parseUpdateFeed(FEED, '.pacman')).toEqual({
      version: '2.5.0',
      artifactPath: 'Artemis-2.5.0-x64.pacman',
      sha512: 'GWaSJsAjQGiKaMIyynkcU9LhQG6KZcvBaDNEYqF6FMOQjGBFACCmDuNkhygOzPpgAOCjBrWEcRYJ2wgAV27Mmg==',
    });
  });

  it('is refused by the platforms that install something else', () => {
    // A feed naming a package is a feed for someone else's machine, and the
    // same answer as no feed at all — never a half-understood one.
    expect(parseUpdateFeed(FEED, '.zip')).toBeNull();
    expect(parseUpdateFeed(FEED, '.exe')).toBeNull();
  });
});
