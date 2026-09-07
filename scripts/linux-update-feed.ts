/**
 * Write the update feed the Arch build reads.
 *
 * electron-builder emits `latest-linux.yml` naming the AppImage, because the
 * AppImage is the only Linux target it considers updatable. Artemis installs
 * the `.pacman` instead — see `apps/desktop/main/updater.ts` — so the feed it
 * reads has to name that file, and nothing upstream will write it.
 *
 * The format is electron-builder's own, and deliberately: `updateFeed.ts`
 * parses one shape, and a second one would be a second thing to keep true.
 * Three top-level fields are what that parser reads — `version`, `path`,
 * `sha512` — and the sha512 is base64, as it is in every other feed here,
 * because that is what the updater compares its own digest against.
 *
 * Runs on the Linux release runner, after electron-builder and from the
 * repository root: `pnpm exec tsx scripts/linux-update-feed.ts`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RELEASE_DIR = join('apps', 'desktop', 'release');
const FEED_NAME = 'latest-linux-pacman.yml';

function sha512Base64(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolve(hash.digest('base64'));
      });
  });
}

const version = (JSON.parse(readFileSync(join('apps', 'desktop', 'package.json'), 'utf8')) as { version: string }).version;

if (!existsSync(RELEASE_DIR)) {
  console.error(`linux-update-feed: ${RELEASE_DIR} does not exist — run electron-builder first.`);
  process.exit(1);
}
const artifact = readdirSync(RELEASE_DIR).find((entry) => entry.endsWith('.pacman'));
if (artifact === undefined) {
  console.error(`linux-update-feed: no .pacman package in ${RELEASE_DIR}.`);
  process.exit(1);
}

const sha512 = await sha512Base64(join(RELEASE_DIR, artifact));
const feed = [
  `version: ${version}`,
  `path: ${artifact}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');

writeFileSync(join(RELEASE_DIR, FEED_NAME), feed);
console.log(join(RELEASE_DIR, FEED_NAME));
