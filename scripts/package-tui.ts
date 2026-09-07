/**
 * Package the terminal UI as one self-contained tarball for this platform.
 *
 * `apps/tui` is a workspace package: it runs off three private packages and
 * the Claude Agent SDK, and none of that exists outside a checkout. What an
 * installer needs is a directory that runs on its own, and pnpm's own
 * `deploy` cannot make one here — without injected workspace packages it
 * links the private packages back into the checkout, and injecting them
 * would change how every developer's install works. So the copy is assembled
 * by hand: the third-party dependencies installed flat into a staging
 * directory, pinned to the versions the workspace resolved, and each
 * workspace package's published files copied in beside them under its own
 * name. Node finds the SDK from core's copy by walking up, exactly as it
 * would in a hoisted install.
 *
 * The SDK ships its CLI as a per-platform optional dependency and pnpm
 * installs only the host's, so the tarball is per platform and this runs
 * once per release runner, as the desktop's own packaging does. The copy is
 * stamped with the desktop's version: a release is one version across
 * everything it ships, and the tag names it. The result is
 * `artemis-tui-<version>-<platform>-<arch>.tar.gz` — a name `install.sh` at
 * the repository root knows — written into `apps/desktop/release/` beside
 * the desktop's own artifacts, and deliberately there: the release workflow
 * uploads that directory as one flat artifact, and a second directory made
 * the artifact keep both parents, which the publish step then tried to
 * upload as files named `desktop` and `tui`.
 *
 * Runs from the repository root: `pnpm exec tsx scripts/package-tui.ts`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
}

const RELEASE_DIR = join('apps', 'desktop', 'release');
const WORKSPACE_DIRS: Readonly<Record<string, string>> = {
  '@rx-artemis/tui': join('apps', 'tui'),
  '@rx-artemis/protocol': join('packages', 'protocol'),
  '@rx-artemis/transcript': join('packages', 'transcript'),
  '@rx-artemis/core': join('packages', 'core'),
};

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;
const run = (command: string, args: readonly string[], cwd?: string): void => {
  execFileSync(command, args, { stdio: 'inherit', ...(cwd === undefined ? {} : { cwd }), env: { ...process.env, CI: 'true' } });
};

const version = readManifest(join('apps', 'desktop', 'package.json')).version;
const target = `${process.platform}-${process.arch}`;
const tarball = `artemis-tui-${version}-${target}.tar.gz`;

/*
 * Every dependency the TUI reaches, walking `workspace:` links: the workspace
 * packages to copy, and the third-party packages to install, each pinned to
 * the version the workspace has on disk so the copy runs what was tested.
 */
const workspacePackages = new Set<string>();
const thirdParty = new Map<string, string>();
const visit = (name: string): void => {
  if (workspacePackages.has(name)) return;
  workspacePackages.add(name);
  const dir = WORKSPACE_DIRS[name];
  if (dir === undefined) throw new Error(`package-tui: ${name} is a workspace package this script does not know the directory of.`);
  for (const [dependency, range] of Object.entries(readManifest(join(dir, 'package.json')).dependencies ?? {})) {
    if (range.startsWith('workspace:')) {
      visit(dependency);
    } else {
      const installed = readManifest(join(dir, 'node_modules', dependency, 'package.json')).version;
      thirdParty.set(dependency, installed);
    }
  }
};
visit('@rx-artemis/tui');

run('pnpm', ['exec', 'tsc', '-b', 'apps/tui']);

const stageParent = mkdtempSync(join(tmpdir(), 'artemis-tui-package-'));
const stage = join(stageParent, 'artemis-tui');
mkdirSync(stage);

writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'artemis-tui',
      version,
      description: 'Artemis in the terminal: the same accounts, models and permission controls as the desktop app.',
      license: 'Apache-2.0',
      type: 'module',
      bin: { artemis: './dist/main.js', 'artemis-tui': './dist/main.js' },
      dependencies: Object.fromEntries([...thirdParty.entries()].sort()),
    },
    null,
    2,
  )}\n`,
);

// Flat, so nothing is a symlink and the archive is what it looks like.
run('pnpm', ['install', '--prod', '--ignore-workspace', '--config.node-linker=hoisted'], stage);
rmSync(join(stage, 'pnpm-lock.yaml'), { force: true });

cpSync(join('apps', 'tui', 'dist'), join(stage, 'dist'), { recursive: true });
// The installer travels with the build: `artemis-tui --update` runs this copy.
cpSync('install.sh', join(stage, 'install.sh'));
for (const name of workspacePackages) {
  if (name === '@rx-artemis/tui') continue;
  const from = WORKSPACE_DIRS[name] as string;
  const to = join(stage, 'node_modules', ...name.split('/'));
  mkdirSync(to, { recursive: true });
  cpSync(join(from, 'package.json'), join(to, 'package.json'));
  for (const entry of readManifest(join(from, 'package.json')).files ?? ['dist']) {
    if (existsSync(join(from, entry))) cpSync(join(from, entry), join(to, entry), { recursive: true });
  }
}

// The copy must run — on its own, from nowhere near the checkout — before it
// is worth shipping.
const reported = execFileSync(process.execPath, [join(stage, 'dist', 'main.js'), '--version'], { encoding: 'utf8', cwd: tmpdir() }).trim();
if (!reported.includes(version)) {
  console.error(`package-tui: the packaged copy reports "${reported}", expected ${version}.`);
  process.exit(1);
}

// Only our own leftovers go; the desktop's artifacts are already here.
mkdirSync(RELEASE_DIR, { recursive: true });
for (const entry of readdirSync(RELEASE_DIR)) {
  if (entry.startsWith('artemis-tui-') && entry.endsWith('.tar.gz')) rmSync(join(RELEASE_DIR, entry));
}
run('tar', ['-czf', join(RELEASE_DIR, tarball), '-C', stageParent, 'artemis-tui']);
rmSync(stageParent, { recursive: true, force: true });
console.log(join(RELEASE_DIR, tarball));
