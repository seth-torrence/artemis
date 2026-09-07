/**
 * The pure half of `memoryBanks.ts` — parsing the CLI's `--json` output and
 * its registry file into the protocol's shapes. Fixtures mirror real output
 * from `bin/cerebro` 0.6.0 (the first multi-bank version), including the
 * cases the numbers hide: profiles that symlink one shared projects store,
 * project entries stamped with a `bank` versus legacy unstamped ones, and the
 * pre-multi-bank `{"bank": path}` registry.
 *
 * The same convention covers the spawn's pure halves, added when the module
 * learned to run on Windows and to reach a private remote: which interpreter
 * to drive the CLI with, what every spawn is told, and what one
 * `git ls-remote` means. Those are decisions rather than I/O, and the fixtures
 * for the last one are stderr the hosts in reach actually produce — the whole
 * value of the feature is that four indistinguishable-looking failures are
 * told apart.
 */

import { describe, expect, it } from 'vitest';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptsAsPython3,
  baseCliEnv,
  categorizeLsRemote,
  configureMemoryBanks,
  isMasterEnabled,
  needsPythonInterpreter,
  parseBanksStatus,
  parseDoctor,
  parseGitOrigin,
  parseMemories,
  parseRegistry,
  PYTHON_CANDIDATES,
  selectPython,
  syncDue,
  withoutSecrets,
  type LsRemoteResult,
  type PythonProbe,
} from './memoryBanks';

const STATUS_FIXTURE = JSON.stringify({
  repo: '/Users/demo/Documents/cerebro',
  source: 'cerebro@52a0a32',
  remote: 'https://github.com/Rx-Ventures/cerebro.git',
  artemis_root: '/Users/demo/Library/Application Support/Artemis',
  bank: { memories: 3, errors: 0, warnings: 0 },
  banks: [
    {
      slug: 'cerebro',
      path: '/Users/demo/Documents/cerebro',
      role: 'readwrite',
      enabled: true,
      default: true,
      exists: true,
      source: 'cerebro@52a0a32',
      remote: 'https://github.com/Rx-Ventures/cerebro.git',
      bank: { memories: 3, errors: 0, warnings: 0 },
    },
    {
      slug: 'client-docs',
      path: '/Users/demo/Documents/client-docs',
      role: 'readonly',
      enabled: false,
      default: false,
      exists: true,
      source: 'cerebro@1a2b3c4',
      remote: null,
      bank: { memories: 5, own: 2, mirrored: 3, errors: 1, warnings: 0 },
    },
  ],
  profiles: [
    {
      name: 'storrence-dev',
      label: 'storrence.dev',
      enabled: true,
      hook: true,
      banks: { cerebro: true, 'client-docs': false },
      projects: [
        // Legacy entries carry no `bank` stamp and belong to the legacy slug…
        { key: '-Users-demo-Documents-app', memories: 3, source: 'cerebro@52a0a32' },
        { key: '-Users-demo-Documents-api', memories: 3, source: 'cerebro@52a0a32' },
        // …stamped entries belong to theirs.
        { key: '-Users-demo-Documents-app', bank: 'client-docs', memories: 5, source: 'cerebro@1a2b3c4' },
      ],
      shared_with: null,
    },
    {
      name: 'work',
      label: 'Work – Team',
      enabled: true,
      hook: false,
      banks: { cerebro: true, 'client-docs': false },
      projects: [],
      shared_with: 'storrence-dev',
    },
  ],
});

describe('parseBanksStatus', () => {
  it('rebuilds the protocol shape from real status output', () => {
    const status = parseBanksStatus(STATUS_FIXTURE, true, true);
    expect(status.cliAvailable).toBe(true);
    expect(status.masterEnabled).toBe(true);
    expect(status.banks).toHaveLength(2);

    const [cerebro, docs] = status.banks;
    expect(cerebro).toEqual({
      slug: 'cerebro',
      path: '/Users/demo/Documents/cerebro',
      remote: 'https://github.com/Rx-Ventures/cerebro.git',
      role: 'readwrite',
      enabled: true,
      isDefault: true,
      exists: true,
      source: 'cerebro@52a0a32',
      memories: 3,
      // A health block that predates mirror trees reads as zero mirrored —
      // the classic bank's truthful answer, not a parse failure.
      mirrored: 0,
      validationErrors: 0,
      projects: 2,
    });
    expect(docs).toMatchObject({
      slug: 'client-docs',
      role: 'readonly',
      enabled: false,
      isDefault: false,
      remote: null,
      memories: 5,
      mirrored: 3,
      validationErrors: 1,
      projects: 1,
    });

    expect(status.profiles).toHaveLength(2);
    expect(status.profiles[0]).toEqual({
      name: 'storrence-dev',
      label: 'storrence.dev',
      hook: true,
      banks: { cerebro: true, 'client-docs': false },
    });
  });

  it('masterEnabled is the caller`s fact, not the CLI`s', () => {
    expect(parseBanksStatus(STATUS_FIXTURE, false, true).masterEnabled).toBe(false);
  });

  it('drops a bank whose slug is not in the banks` own grammar', () => {
    const status = parseBanksStatus(
      JSON.stringify({
        banks: [{ slug: '../escape', path: '/x', role: 'readwrite', enabled: true }],
        profiles: [],
      }),
      true,
      true,
    );
    expect(status.banks).toHaveLength(0);
  });

  it('refuses output that is not JSON, in its own words', () => {
    expect(() => parseBanksStatus('warning: something\n{', true, true)).toThrow(/not JSON/);
  });
});

describe('parseRegistry', () => {
  it('reads the multi-bank shape, defaulting role and enabled', () => {
    const { banks, defaultSlug } = parseRegistry(
      JSON.stringify({
        banks: [
          { slug: 'cerebro', path: '/a' },
          { slug: 'docs', path: '/b', role: 'readonly', enabled: false },
        ],
        default: 'cerebro',
      }),
    );
    expect(banks).toEqual([
      { slug: 'cerebro', path: '/a', role: 'readwrite', enabled: true },
      { slug: 'docs', path: '/b', role: 'readonly', enabled: false },
    ]);
    expect(defaultSlug).toBe('cerebro');
  });

  it('reads the pre-multi-bank shape as one legacy bank', () => {
    const { banks, defaultSlug } = parseRegistry(JSON.stringify({ bank: '/Users/demo/Documents/cerebro' }));
    expect(banks).toEqual([
      { slug: 'cerebro', path: '/Users/demo/Documents/cerebro', role: 'readwrite', enabled: true },
    ]);
    expect(defaultSlug).toBe('cerebro');
  });

  it('falls back to the first bank when the default names nobody', () => {
    const { defaultSlug } = parseRegistry(
      JSON.stringify({ banks: [{ slug: 'a', path: '/a' }], default: 'gone' }),
    );
    expect(defaultSlug).toBe('a');
  });

  it('drops malformed entries and survives garbage whole', () => {
    expect(parseRegistry('not json')).toEqual({ banks: [], defaultSlug: null });
    const { banks } = parseRegistry(
      JSON.stringify({ banks: [{ slug: 'ok', path: '/a' }, { slug: 'NO CAPS', path: '/b' }, { path: '/c' }, 42] }),
    );
    expect(banks.map((bank) => bank.slug)).toEqual(['ok']);
  });
});

const LIST_FIXTURE = JSON.stringify([
  {
    name: 'deploy-approval-flow',
    description: 'When deploying to production',
    metadata: { type: 'project', added: '2026-08-14', author: 'demo@example.com' },
    body: 'Deploys need approval in #deploys first.',
    file: 'memories/deploy-approval-flow.md',
    org: null,
    project: null,
    tree: 'memories',
    readonly: false,
    errors: [],
    warnings: [],
  },
  // A mirror-tree memory: grouped under org/project and read-only.
  {
    name: 'unraid-server',
    description: 'The Unraid box and how to reach it',
    metadata: { type: 'reference' },
    body: 'Tailscale IP, GraphQL API, key in the vault.',
    file: 'memory/claude/unraid-server.md',
    org: 'personal',
    project: 'claude',
    tree: 'memory',
    readonly: true,
    errors: [],
    warnings: [],
  },
  // A file the bank could not parse: name-less, carried for the error count.
  { file: 'memories/broken.md', errors: ['no frontmatter'] },
]);

describe('parseMemories', () => {
  it('maps parseable entries and drops the name-less', () => {
    const memories = parseMemories(LIST_FIXTURE);
    expect(memories).toHaveLength(2);
    expect(memories[0]).toEqual({
      name: 'deploy-approval-flow',
      type: 'project',
      description: 'When deploying to production',
      body: 'Deploys need approval in #deploys first.',
      added: '2026-08-14',
      author: 'demo@example.com',
      org: null,
      project: null,
      readonly: false,
      file: 'memories/deploy-approval-flow.md',
    });
    expect(memories[1]).toMatchObject({
      name: 'unraid-server',
      org: 'personal',
      project: 'claude',
      readonly: true,
      file: 'memory/claude/unraid-server.md',
      added: null,
      author: null,
    });
  });

  it('refuses a non-array, in its own words', () => {
    expect(() => parseMemories('{}')).toThrow(/not an array/);
  });
});

describe('parseDoctor', () => {
  it('rebuilds checks and drops unknown states', () => {
    const preflight = parseDoctor(
      JSON.stringify({
        ready: false,
        checks: [
          { id: 'git', label: 'git', state: 'ok', detail: 'git version 2.55.0', remedy: null },
          { id: 'weird', label: 'Future', state: 'exploded', detail: 'x', remedy: null },
          {
            id: 'git-identity',
            label: 'git identity',
            state: 'fail',
            detail: 'unset',
            remedy: 'git config --global …',
          },
        ],
      }),
    );
    expect(preflight.ready).toBe(false);
    expect(preflight.checks.map((check) => check.id)).toEqual(['git', 'git-identity']);
    expect(preflight.checks[1]?.remedy).toBe('git config --global …');
  });
});

describe('the master switch', () => {
  it('reads as off until configured, and off when the file is absent', () => {
    configureMemoryBanks(mkdtempSync(join(tmpdir(), 'artemis-banks-')));
    expect(isMasterEnabled()).toBe(false);
  });

  it('reads the historical cerebro.json, so an upgrade keeps the yes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artemis-banks-'));
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: true }));
    configureMemoryBanks(dir);
    expect(isMasterEnabled()).toBe(true);
  });

  it('treats anything but `enabled: true` as off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artemis-banks-'));
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: 'yes' }));
    configureMemoryBanks(dir);
    expect(isMasterEnabled()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Getting the CLI to run at all                                              */
/* -------------------------------------------------------------------------- */

/**
 * The Windows spawn, as the pure decision behind it.
 *
 * Before this, every bank operation threw on Windows before the CLI's first
 * line ran: the file is an extension-less Python script with a shebang, which
 * `execFile` cannot start on a platform that has no shebang support and
 * matches executables by `PATHEXT`. What is testable without a machine is the
 * decision — does this path need an interpreter, and is this thing calling
 * itself Python actually one.
 */
describe('needsPythonInterpreter', () => {
  it('is true for the shipped CLI on Windows and false everywhere else', () => {
    expect(needsPythonInterpreter('C:/App/resources/cerebro', 'win32')).toBe(true);
    expect(needsPythonInterpreter('/Applications/Artemis.app/resources/cerebro', 'darwin')).toBe(false);
    expect(needsPythonInterpreter('/usr/share/artemis/cerebro', 'linux')).toBe(false);
  });

  it('leaves a real executable alone, so a bank may embed one', () => {
    // Resolution also finds a bank's *own* copy of the CLI, and a bank is free
    // to ship something Windows can start by itself.
    expect(needsPythonInterpreter('C:/banks/team/bin/cerebro.exe', 'win32')).toBe(false);
    expect(needsPythonInterpreter('C:/banks/team/bin/cerebro.cmd', 'win32')).toBe(false);
    expect(needsPythonInterpreter('C:/banks/team/bin/cerebro.BAT', 'win32')).toBe(false);
  });
});

describe('acceptsAsPython3', () => {
  const probe = (over: Partial<PythonProbe>): PythonProbe => ({
    ok: true,
    stdout: '',
    stderr: '',
    ...over,
  });

  it('accepts a real Python 3, from either stream', () => {
    expect(acceptsAsPython3(probe({ stdout: 'Python 3.13.1\n' }))).toBe(true);
    // `--version` went to stderr on 3.3 and earlier.
    expect(acceptsAsPython3(probe({ stderr: 'Python 3.8.10\n' }))).toBe(true);
  });

  it('rejects the Windows Store stub, which exits fine and says nothing', () => {
    // The rejection that matters. `WindowsApps\python3.exe` is an
    // app-execution alias whose whole job is to open the Store; accepting it
    // means every later spawn either opens a shop or fails in a way that names
    // no Python at all.
    expect(acceptsAsPython3(probe({ ok: true, stdout: '', stderr: '' }))).toBe(false);
    expect(acceptsAsPython3(probe({ ok: true, stdout: '   \n' }))).toBe(false);
  });

  it('rejects a failed probe and a Python 2', () => {
    expect(acceptsAsPython3(probe({ ok: false, stderr: 'python3 is not recognized' }))).toBe(false);
    expect(acceptsAsPython3(probe({ stdout: 'Python 2.7.18' }))).toBe(false);
    expect(acceptsAsPython3(probe({ stdout: 'Perl 5.38.0' }))).toBe(false);
  });
});

describe('selectPython', () => {
  const said = (text: string): PythonProbe => ({ ok: true, stdout: text, stderr: '' });
  const failed: PythonProbe = { ok: false, stdout: '', stderr: 'not found' };

  it('tries the launcher first, so a machine with Python 2 still gets 3', () => {
    expect(PYTHON_CANDIDATES.map((candidate) => [candidate.command, ...candidate.args].join(' '))).toEqual([
      'py -3',
      'python3',
      'python',
    ]);
  });

  it('takes the first candidate that answers as Python 3', () => {
    const chosen = selectPython([
      { candidate: { command: 'py', args: ['-3'] }, probe: failed },
      { candidate: { command: 'python3', args: [] }, probe: said('Python 3.12.4') },
    ]);
    expect(chosen).toEqual({ command: 'python3', args: [] });
  });

  it('skips a stub that exited zero in favour of the next candidate', () => {
    const chosen = selectPython([
      { candidate: { command: 'python3', args: [] }, probe: said('') },
      { candidate: { command: 'python', args: [] }, probe: said('Python 3.11.9') },
    ]);
    expect(chosen).toEqual({ command: 'python', args: [] });
  });

  it('is null when nothing on the machine is a Python 3', () => {
    expect(
      selectPython([
        { candidate: { command: 'py', args: ['-3'] }, probe: failed },
        { candidate: { command: 'python3', args: [] }, probe: said('') },
        { candidate: { command: 'python', args: [] }, probe: said('Python 2.7.18') },
      ]),
    ).toBeNull();
  });
});

/**
 * The environment every spawn is told, which is the fix for the *other* thing
 * that was broken off macOS: without `ARTEMIS_ROOT` the CLI looks for
 * `profiles.json` under `~/Library/Application Support/Artemis`, finds none on
 * any other platform, and `doctor` reports the machine unready forever.
 */
describe('baseCliEnv', () => {
  it('names the Artemis root and forbids a terminal prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artemis-banks-'));
    configureMemoryBanks(dir);
    expect(baseCliEnv()).toEqual({ ARTEMIS_ROOT: dir, GIT_TERMINAL_PROMPT: '0' });
  });
});

/* -------------------------------------------------------------------------- */
/* Verifying a remote                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The categorisation, against stderr the hosts in reach actually produce.
 *
 * These strings are the point of the feature. "Could not clone" is true of a
 * private repository, a typo, a laptop on a plane and a repository that does
 * not exist, and the four remedies are entirely different — so what is
 * asserted here is that each one lands in the category whose remedy is the
 * right one.
 */
describe('categorizeLsRemote', () => {
  const ran = (over: Partial<LsRemoteResult>): LsRemoteResult => ({
    code: 128,
    timedOut: false,
    stdout: '',
    stderr: '',
    ...over,
  });

  it('reads a HEAD line as a reachable repository', () => {
    const result = categorizeLsRemote(
      ran({ code: 0, stdout: '52a0a3271f9c4b0e8d3a6f2c1b7e9d40a5c8e136\tHEAD\n' }),
    );
    expect(result.outcome).toBe('ok');
    expect(result.headPresent).toBe(true);
    expect(result.detail).toContain('52a0a327');
  });

  it('reads exit 2 with nothing fatal as a readable, empty repository', () => {
    // `--exit-code` exits 2 when no ref matched, which for HEAD means an empty
    // repo — a perfectly good bank to join, and what a team's second machine
    // sees on the day the bank is created.
    const result = categorizeLsRemote(ran({ code: 2 }));
    expect(result.outcome).toBe('ok');
    expect(result.headPresent).toBe(false);
  });

  it('reads a prompt that could not be answered as needing credentials', () => {
    // The everyday private-repo case, with GIT_TERMINAL_PROMPT=0 in force.
    expect(
      categorizeLsRemote(
        ran({
          stderr:
            "fatal: could not read Username for 'https://git.example.com': terminal prompts disabled\n",
        }),
      ).outcome,
    ).toBe('auth-required');
  });

  it('reads a rejected token as needing credentials, not as an outage', () => {
    // Both hosts answer through "unable to access", which also matches a
    // connectivity shape — the auth patterns are asked first for this reason.
    expect(
      categorizeLsRemote(
        ran({
          stderr:
            "fatal: unable to access 'https://git.example.com/team/bank.git/': The requested URL returned error: 403\n",
        }),
      ).outcome,
    ).toBe('auth-required');
    expect(
      categorizeLsRemote(ran({ stderr: "fatal: Authentication failed for 'https://git.example.com/'\n" }))
        .outcome,
    ).toBe('auth-required');
  });

  it('reads a missing repository as missing', () => {
    expect(
      categorizeLsRemote(ran({ stderr: 'remote: Repository not found.\nfatal: repository not found\n' }))
        .outcome,
    ).toBe('not-found');
  });

  it('reads a name that will not resolve, or a host that will not answer, as unreachable', () => {
    expect(
      categorizeLsRemote(
        ran({
          stderr: "fatal: unable to access 'https://nope.invalid/': Could not resolve host: nope.invalid\n",
        }),
      ).outcome,
    ).toBe('unreachable');
    expect(
      categorizeLsRemote(ran({ stderr: 'fatal: unable to access: Failed to connect to 10.0.0.9 port 443\n' }))
        .outcome,
    ).toBe('unreachable');
  });

  it('reports a timeout as unreachable, in its own words', () => {
    const result = categorizeLsRemote(ran({ code: null, timedOut: true }));
    expect(result.outcome).toBe('unreachable');
    expect(result.detail).toMatch(/did not answer/);
  });

  it('carries the last line git wrote, which is the useful one', () => {
    const result = categorizeLsRemote(
      ran({ stderr: 'Cloning into bare repository...\nremote: Repository not found.\n' }),
    );
    expect(result.detail).toBe('remote: Repository not found.');
  });
});

/**
 * The scrub that stands between a token and the pane.
 *
 * Nothing observed says git echoes a password it was handed. This is what
 * makes that a claim the boundary does not have to rely on.
 */
describe('withoutSecrets', () => {
  it('removes the exact token, wherever it appears', () => {
    const token = 'forgejo-9f3c1a77b2e04d6a8c5f0e1b7d4a9268';
    const said = `fatal: authentication failed with ${token} for https://git.example.com`;
    const scrubbed = withoutSecrets(said, [token]);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain('[redacted]');
  });

  it('still applies the shape rules to everything else', () => {
    expect(withoutSecrets('remote said sk-ant-abcdefghijklmnop', [])).toContain('[redacted]');
  });

  it('leaves an ordinary message alone', () => {
    expect(withoutSecrets('remote: Repository not found.', [])).toBe('remote: Repository not found.');
  });
});

/**
 * Finding a bank's origin without spawning anything, because this is read on
 * the background sync's path — which fires at the start of every run.
 */
describe('parseGitOrigin', () => {
  it('reads origin’s url out of a real .git/config', () => {
    expect(
      parseGitOrigin(
        [
          '[core]',
          '\trepositoryformatversion = 0',
          '[remote "upstream"]',
          '\turl = https://git.example.com/other/thing.git',
          '[remote "origin"]',
          '\turl = https://git.example.com/team/bank.git',
          '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        ].join('\n'),
      ),
    ).toBe('https://git.example.com/team/bank.git');
  });

  it('is null for a repository with no origin, and for anything unreadable', () => {
    expect(parseGitOrigin('[core]\n\tbare = false\n')).toBeNull();
    expect(parseGitOrigin('')).toBeNull();
  });
});

describe('syncDue: the per-directory throttle', () => {
  const MINUTE = 60_000;

  it('lets the first sync through, and the same directory again after a minute', () => {
    expect(syncDue({ lastSyncAt: 0 }, '/w/app', 1)).toBe(true);
    expect(syncDue({ lastSyncAt: 1000, lastSyncCwd: '/w/app' }, '/w/app', 1000 + MINUTE)).toBe(true);
  });

  it('skips a burst of runs in the directory it just synced', () => {
    expect(syncDue({ lastSyncAt: 1000, lastSyncCwd: '/w/app' }, '/w/app', 1000 + MINUTE / 2)).toBe(false);
    // A caller that names no directory is the old behaviour: throttled by time alone.
    expect(syncDue({ lastSyncAt: 1000, lastSyncCwd: '/w/app' }, undefined, 1000 + MINUTE / 2)).toBe(false);
  });

  it('goes through for a directory the last sync did not know about', () => {
    /*
     * The case the time-only throttle swallowed: a second project opened
     * within a minute of the first started without its bank installed, and
     * stayed that way until a bank commit happened to trigger the
     * every-project install.
     */
    expect(syncDue({ lastSyncAt: 1000, lastSyncCwd: '/w/app' }, '/w/other', 1000 + 5)).toBe(true);
    expect(syncDue({ lastSyncAt: 1000 }, '/w/app', 1000 + 5)).toBe(true);
  });
});
