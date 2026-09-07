/**
 * The content bridges, against a real filesystem.
 * ============================================================================
 *
 * No mocked `fs`, for the reason `sharedConfig.test.ts` gives: symlinks are the
 * subject matter, and a test against a fake `readlink` agrees with whatever the
 * author believed `readlink` does. Both bridges exist to be real directories
 * that a subprocess reads, so these build them and read them.
 *
 * **Every test passes `home`.** Both functions default it to the real
 * `homedir()`, and the developer's own `~/.agents/skills` and `~/.codex/skills`
 * have skills in them — a suite that let the default through would pass or fail
 * depending on whose machine it ran on, and would have been green here for the
 * wrong reason.
 *
 * The assertions that matter most are not about the happy path:
 *
 *  - **Nothing but skills.** The Claude bridge exists because a plugin directory
 *    is also read for `commands/`, `agents/` and hooks, and the guarantee that
 *    it contributes none of them holds only while the directory stays empty of
 *    them. One test seeds a config dir with all of those and asserts the bridge
 *    still holds exactly two entries — the test that fails if someone ever
 *    "helpfully" links the config dir wholesale.
 *  - **Codex's directory is shared, not owned.** Codex writes `.system/` into
 *    the same directory this links into, and a user may install a skill there by
 *    hand. Four tests pin down what must survive contact with the linker.
 *
 * Skipped on Windows, where an unprivileged `symlink` fails and the desktop app
 * is not shipped.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildContentBridge,
  discoverMarketplacePlugins,
  linkSkillsIntoCodexHome,
} from './bridge.js';

const describeIfSymlinks = process.platform === 'win32' ? describe.skip : describe;

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  /** Stands in for a profile's config directory (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`). */
  readonly configDir: string;
  /** Stands in for Artemis's own `userData`. */
  readonly dataDir: string;
  /** Stands in for `$HOME`. */
  readonly home: string;
}

function sandbox(): Sandbox {
  // A space in the path on purpose: the real one is `~/Library/Application
  // Support/Artemis`, and a path with a space is where naive quoting fails.
  const root = mkdtempSync(path.join(tmpdir(), 'artemis-skills-'));
  sandboxes.push(root);
  const configDir = path.join(root, 'Application Support', 'profile');
  const dataDir = path.join(root, 'Application Support', 'data');
  const home = path.join(root, 'home');
  for (const dir of [configDir, dataDir, home]) mkdirSync(dir, { recursive: true });
  return { configDir, dataDir, home };
}

/** Write a skill into a directory, the way a user installing one would. */
function seedSkill(skillsDir: string, name: string, marker = name): void {
  mkdirSync(path.join(skillsDir, name), { recursive: true });
  writeFileSync(
    path.join(skillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A skill for testing.\n---\n\n# ${marker}\n`,
  );
}

/** Write a slash command into a directory, the way a user installing one would. */
function seedCommand(commandsDir: string, name: string): void {
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(
    path.join(commandsDir, `${name}.md`),
    `---\ndescription: A command for testing.\n---\n\nDo the ${name} thing: $ARGUMENTS\n`,
  );
}

/** What a CLI would find under a bridged directory, symlinks and all. */
function listSkills(skillsDir: string): readonly string[] {
  return readdirSync(skillsDir).sort();
}

describeIfSymlinks('buildContentBridge (Claude)', () => {
  it('bridges the skills in a config directory', async () => {
    const { configDir, dataDir, home } = sandbox();
    seedSkill(path.join(configDir, 'skills'), 'use-railway');
    seedSkill(path.join(configDir, 'skills'), 'supacode-cli');

    const plugins = await buildContentBridge({ configDir, dataDir, home });

    expect(plugins).toHaveLength(1);
    expect(path.isAbsolute(plugins[0]!.path)).toBe(true);
    expect(listSkills(path.join(plugins[0]!.path, 'skills'))).toEqual([
      'supacode-cli',
      'use-railway',
    ]);

    const manifest = JSON.parse(
      readFileSync(path.join(plugins[0]!.path, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('artemis-skills');
  });

  it('follows a symlinked skills directory, which is the shipping arrangement', async () => {
    const { configDir, dataDir, home } = sandbox();
    // What `sharedConfig` sets up: the profile's `skills` is a link to the
    // user's own directory, so discovery resolves through two hops.
    const real = path.join(home, '.claude', 'skills');
    seedSkill(real, 'use-railway');
    symlinkSync(real, path.join(configDir, 'skills'), 'dir');

    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    expect(listSkills(path.join(plugin!.path, 'skills'))).toEqual(['use-railway']);
  });

  it('includes the vendor-neutral ~/.agents/skills, which Claude does not read itself', async () => {
    const { configDir, dataDir, home } = sandbox();
    seedSkill(path.join(configDir, 'skills'), 'supacode-cli');
    seedSkill(path.join(home, '.agents', 'skills'), 'use-railway');

    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    expect(listSkills(path.join(plugin!.path, 'skills'))).toEqual([
      'supacode-cli',
      'use-railway',
    ]);
  });

  it('offers a skill present in both sources once, preferring the vendor copy', async () => {
    const { configDir, dataDir, home } = sandbox();
    // The real case on this machine: `use-railway` is installed in both.
    seedSkill(path.join(configDir, 'skills'), 'use-railway', 'vendor-copy');
    seedSkill(path.join(home, '.agents', 'skills'), 'use-railway', 'neutral-copy');

    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    const bridged = path.join(plugin!.path, 'skills');
    expect(listSkills(bridged)).toEqual(['use-railway']);
    expect(readFileSync(path.join(bridged, 'use-railway', 'SKILL.md'), 'utf8')).toContain(
      'vendor-copy',
    );
  });

  it('contributes skills and commands, and nothing else', async () => {
    const { configDir, dataDir, home } = sandbox();
    seedSkill(path.join(configDir, 'skills'), 'use-railway');
    seedCommand(path.join(configDir, 'commands'), 'cerebro');
    // The other two surfaces a plugin directory is read for. Both present in the
    // config dir, and both required to stay out of the bridge — this is the test
    // that fails if someone ever links the config dir wholesale.
    for (const surface of ['agents', 'hooks']) {
      mkdirSync(path.join(configDir, surface), { recursive: true });
      writeFileSync(path.join(configDir, surface, 'leak.md'), 'should not be loaded');
    }
    writeFileSync(path.join(configDir, 'settings.json'), '{"hooks":{}}');
    writeFileSync(path.join(configDir, 'hooks.json'), '{}');

    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    expect(listSkills(plugin!.path)).toEqual(['.claude-plugin', 'commands', 'skills']);
  });

  it('bridges commands, keeping namespace subdirectories intact', async () => {
    const { configDir, dataDir, home } = sandbox();
    const commandsDir = path.join(configDir, 'commands');
    seedCommand(commandsDir, 'cerebro');
    // `commands/review/pr.md` is `/review:pr`, so the nesting is meaning and not
    // just filing — a flat link-per-entry pass would have flattened it.
    seedCommand(path.join(commandsDir, 'review'), 'pr');

    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    const bridged = path.join(plugin!.path, 'commands');
    expect(listSkills(bridged)).toEqual(['cerebro.md', 'review']);
    expect(listSkills(path.join(bridged, 'review'))).toEqual(['pr.md']);
  });

  it('bridges a profile that has commands but no skills', async () => {
    const { configDir, dataDir, home } = sandbox();
    seedCommand(path.join(configDir, 'commands'), 'cerebro');

    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    expect(plugin).toBeDefined();
    expect(listSkills(path.join(plugin!.path, 'commands'))).toEqual(['cerebro.md']);
  });

  it('finds commands filed only inside a namespace directory', async () => {
    const { configDir, dataDir, home } = sandbox();
    seedCommand(path.join(configDir, 'commands', 'review'), 'pr');

    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    expect(plugin).toBeDefined();
  });

  it('drops the commands link when the user deletes their commands', async () => {
    const { configDir, dataDir, home } = sandbox();
    seedSkill(path.join(configDir, 'skills'), 'use-railway');
    const commandsDir = path.join(configDir, 'commands');
    seedCommand(commandsDir, 'cerebro');
    const [plugin] = await buildContentBridge({ configDir, dataDir, home });
    expect(listSkills(plugin!.path)).toContain('commands');

    // A link left pointing at a directory that no longer exists is a broken
    // read, not an empty one.
    rmSync(commandsDir, { recursive: true });
    await buildContentBridge({ configDir, dataDir, home });

    expect(listSkills(plugin!.path)).toEqual(['.claude-plugin', 'skills']);
  });

  it('ignores a commands directory with nothing in it', async () => {
    const { configDir, dataDir, home } = sandbox();
    seedSkill(path.join(configDir, 'skills'), 'use-railway');
    mkdirSync(path.join(configDir, 'commands', 'empty-namespace'), { recursive: true });
    writeFileSync(path.join(configDir, 'commands', 'notes.txt'), 'not a command');

    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    expect(listSkills(plugin!.path)).toEqual(['.claude-plugin', 'skills']);
  });

  it('picks up a skill installed after the bridge was built', async () => {
    const { configDir, dataDir, home } = sandbox();
    const skillsDir = path.join(configDir, 'skills');
    seedSkill(skillsDir, 'use-railway');

    const [first] = await buildContentBridge({ configDir, dataDir, home });
    seedSkill(skillsDir, 'newly-installed');
    const [second] = await buildContentBridge({ configDir, dataDir, home });

    expect(second!.path).toBe(first!.path);
    expect(listSkills(path.join(second!.path, 'skills'))).toEqual([
      'newly-installed',
      'use-railway',
    ]);
  });

  it('stops offering a skill the user uninstalled', async () => {
    const { configDir, dataDir, home } = sandbox();
    const skillsDir = path.join(configDir, 'skills');
    seedSkill(skillsDir, 'use-railway');
    seedSkill(skillsDir, 'going-away');
    await buildContentBridge({ configDir, dataDir, home });

    rmSync(path.join(skillsDir, 'going-away'), { recursive: true });
    const [plugin] = await buildContentBridge({ configDir, dataDir, home });

    expect(listSkills(path.join(plugin!.path, 'skills'))).toEqual(['use-railway']);
  });

  it('gives each config directory its own bridge', async () => {
    const { configDir, dataDir, home } = sandbox();
    seedSkill(path.join(configDir, 'skills'), 'use-railway');
    const [mine] = await buildContentBridge({ configDir, dataDir, home });

    const other = sandbox();
    seedSkill(path.join(other.configDir, 'skills'), 'somebody-elses');
    const [theirs] = await buildContentBridge({
      configDir: other.configDir,
      dataDir,
      home: other.home,
    });

    expect(theirs!.path).not.toBe(mine!.path);
    expect(listSkills(path.join(theirs!.path, 'skills'))).toEqual(['somebody-elses']);
    expect(listSkills(path.join(mine!.path, 'skills'))).toEqual(['use-railway']);
  });

  describe('when there is nothing to bridge', () => {
    it('returns no plugins for a config dir with no skills directory', async () => {
      const { configDir, dataDir, home } = sandbox();
      await expect(buildContentBridge({ configDir, dataDir, home })).resolves.toEqual([]);
    });

    it('returns no plugins for an empty skills directory', async () => {
      const { configDir, dataDir, home } = sandbox();
      mkdirSync(path.join(configDir, 'skills'), { recursive: true });
      await expect(buildContentBridge({ configDir, dataDir, home })).resolves.toEqual([]);
    });

    it('ignores entries that are not skills', async () => {
      const { configDir, dataDir, home } = sandbox();
      const skillsDir = path.join(configDir, 'skills');
      mkdirSync(path.join(skillsDir, 'leftovers'), { recursive: true });
      mkdirSync(path.join(skillsDir, '.hidden'), { recursive: true });
      writeFileSync(path.join(skillsDir, '.hidden', 'SKILL.md'), 'hidden');
      writeFileSync(path.join(skillsDir, '.DS_Store'), '');
      writeFileSync(path.join(skillsDir, 'README.md'), 'notes');

      await expect(buildContentBridge({ configDir, dataDir, home })).resolves.toEqual([]);
    });

    it('does not fail a run when the bridge cannot be written', async () => {
      const { configDir, home } = sandbox();
      seedSkill(path.join(configDir, 'skills'), 'use-railway');

      // A data dir that cannot hold a directory, because a file occupies the
      // name. The contract is an empty list and a log line, never a throw: a
      // missing skill must not be a session the user cannot start.
      const blocked = path.join(home, 'blocked');
      writeFileSync(blocked, 'not a directory');

      await expect(buildContentBridge({ configDir, dataDir: blocked, home })).resolves.toEqual([]);
    });
  });
});

describeIfSymlinks('discoverMarketplacePlugins', () => {
  /**
   * Write the two files a `/plugin install` leaves behind.
   *
   * `installed_plugins.json` goes under the *config* directory, because that is
   * where the CLI reads it from and where the profile's `plugins` symlink puts
   * the user's real one. `settings.json` goes under `$HOME`, because that is the
   * file the CLI writes `enabledPlugins` into — the split this function exists
   * to reconcile.
   */
  function seedInstall(options: {
    readonly configDir: string;
    readonly home: string;
    readonly key: string;
    readonly installPath: string;
    /** Omit to write no `enabledPlugins` entry at all. */
    readonly enabled?: boolean | Record<string, unknown>;
    /** Skip writing the plugin manifest, standing in for a pruned cache. */
    readonly withoutManifest?: boolean;
  }): void {
    if (!options.withoutManifest) {
      mkdirSync(path.join(options.installPath, '.claude-plugin'), { recursive: true });
      writeFileSync(
        path.join(options.installPath, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: options.key.split('@')[0], version: '1.0.0' }),
      );
    }

    const record = path.join(options.configDir, 'plugins', 'installed_plugins.json');
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(
      record,
      JSON.stringify({
        version: 2,
        plugins: {
          [options.key]: [
            { scope: 'user', installPath: options.installPath, version: '1.0.0' },
          ],
        },
      }),
    );

    if (options.enabled === undefined) return;
    const settings = path.join(options.home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ enabledPlugins: { [options.key]: options.enabled } }));
  }

  it('hands a run the plugin the user enabled, by its own install path', async () => {
    const { configDir, home } = sandbox();
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'mattpocock', '1.2.3');
    seedInstall({
      configDir,
      home,
      key: 'mattpocock-skills@claude-plugins-official',
      installPath,
      enabled: true,
    });

    await expect(discoverMarketplacePlugins({ configDir, home })).resolves.toEqual([
      { path: installPath },
    ]);
  });

  it('reads enabledPlugins from ~/.claude even though settings.json is not shared', async () => {
    // The whole bug: the profile has its own `settings.json` and it will never
    // hold `enabledPlugins`, because the CLI writes the user's file. A version
    // of this that read only the profile's would find nothing, every time.
    const { configDir, home } = sandbox();
    writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ hooks: {} }));
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'plugin', '1.0.0');
    seedInstall({ configDir, home, key: 'plugin@market', installPath, enabled: true });

    const plugins = await discoverMarketplacePlugins({ configDir, home });

    expect(plugins).toEqual([{ path: installPath }]);
  });

  it('lets the profile turn off a plugin the user enabled globally', async () => {
    const { configDir, home } = sandbox();
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'plugin', '1.0.0');
    seedInstall({ configDir, home, key: 'plugin@market', installPath, enabled: true });
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'plugin@market': false } }),
    );

    await expect(discoverMarketplacePlugins({ configDir, home })).resolves.toEqual([]);
  });

  it('takes an extended enablement value as "on", not as unrecognised', async () => {
    // The field also accepts an object carrying a version constraint. Reading it
    // as anything but enabled would drop a plugin over a syntax this function
    // does not need to understand.
    const { configDir, home } = sandbox();
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'plugin', '1.0.0');
    seedInstall({
      configDir,
      home,
      key: 'plugin@market',
      installPath,
      enabled: { version: '^1.0.0' },
    });

    await expect(discoverMarketplacePlugins({ configDir, home })).resolves.toEqual([
      { path: installPath },
    ]);
  });

  it('ignores an installed plugin nobody enabled', async () => {
    const { configDir, home } = sandbox();
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'plugin', '1.0.0');
    seedInstall({ configDir, home, key: 'plugin@market', installPath });

    await expect(discoverMarketplacePlugins({ configDir, home })).resolves.toEqual([]);
  });

  it('drops an enabled plugin whose files are gone rather than pointing a run at them', async () => {
    const { configDir, home } = sandbox();
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'pruned', '1.0.0');
    seedInstall({
      configDir,
      home,
      key: 'plugin@market',
      installPath,
      enabled: true,
      withoutManifest: true,
    });

    await expect(discoverMarketplacePlugins({ configDir, home })).resolves.toEqual([]);
  });

  it('drops a relative install path, which the adapter would refuse outright', async () => {
    const { configDir, home } = sandbox();
    mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'plugin@market': [{ scope: 'user', installPath: './somewhere' }] },
      }),
    );
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'plugin@market': true } }),
    );

    await expect(discoverMarketplacePlugins({ configDir, home })).resolves.toEqual([]);
  });

  it('survives settings a user is mid-edit in', async () => {
    const { configDir, home } = sandbox();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), '{ "enabledPlugins": {');

    await expect(discoverMarketplacePlugins({ configDir, home })).resolves.toEqual([]);
  });

  it('returns nothing at all on a machine that has never installed a plugin', async () => {
    const { configDir, home } = sandbox();

    await expect(discoverMarketplacePlugins({ configDir, home })).resolves.toEqual([]);
  });
});

describeIfSymlinks('linkSkillsIntoCodexHome', () => {
  /** Where Codex reads a profile's skills from. */
  const codexSkills = (configDir: string): string => path.join(configDir, 'skills');

  it("links the user's Codex skills into the profile", async () => {
    const { configDir, home } = sandbox();
    seedSkill(path.join(home, '.codex', 'skills'), 'supacode-cli');
    seedSkill(path.join(home, '.codex', 'skills'), 'use-railway');

    await linkSkillsIntoCodexHome({ configDir, home });

    expect(listSkills(codexSkills(configDir))).toEqual(['supacode-cli', 'use-railway']);
    expect(
      readFileSync(path.join(codexSkills(configDir), 'use-railway', 'SKILL.md'), 'utf8'),
    ).toContain('use-railway');
  });

  it("leaves Codex's own .system directory alone", async () => {
    const { configDir, home } = sandbox();
    seedSkill(path.join(home, '.codex', 'skills'), 'use-railway');
    // Codex creates and refreshes this, in the directory we are linking into.
    seedSkill(path.join(codexSkills(configDir), '.system'), 'imagegen');

    await linkSkillsIntoCodexHome({ configDir, home });

    expect(listSkills(codexSkills(configDir))).toEqual(['.system', 'use-railway']);
    expect(listSkills(path.join(codexSkills(configDir), '.system'))).toEqual(['imagegen']);
  });

  it('never touches a real directory, so a hand-installed skill wins its name', async () => {
    const { configDir, home } = sandbox();
    seedSkill(path.join(home, '.codex', 'skills'), 'use-railway', 'from-home');
    // Installed into the profile directly — a supported thing to do, and not
    // ours to delete.
    seedSkill(codexSkills(configDir), 'use-railway', 'installed-in-profile');

    await linkSkillsIntoCodexHome({ configDir, home });

    expect(
      readFileSync(path.join(codexSkills(configDir), 'use-railway', 'SKILL.md'), 'utf8'),
    ).toContain('installed-in-profile');
  });

  it("leaves a symlink belonging to someone else's arrangement", async () => {
    const { configDir, home } = sandbox();
    seedSkill(path.join(home, '.codex', 'skills'), 'other-skill');
    const dotfiles = path.join(home, 'dotfiles', 'skills');
    seedSkill(dotfiles, 'use-railway', 'from-dotfiles');
    mkdirSync(codexSkills(configDir), { recursive: true });
    symlinkSync(
      path.join(dotfiles, 'use-railway'),
      path.join(codexSkills(configDir), 'use-railway'),
      'dir',
    );

    await linkSkillsIntoCodexHome({ configDir, home });

    expect(readlinkSync(path.join(codexSkills(configDir), 'use-railway'))).toBe(
      path.join(dotfiles, 'use-railway'),
    );
    expect(listSkills(codexSkills(configDir))).toEqual(['other-skill', 'use-railway']);
  });

  it('does not link a skill Codex already reads from ~/.agents/skills', async () => {
    const { configDir, home } = sandbox();
    // The real case: `use-railway` is in both, and Codex reads the neutral
    // directory whatever `CODEX_HOME` says. Linking ours too listed it twice.
    seedSkill(path.join(home, '.codex', 'skills'), 'use-railway');
    seedSkill(path.join(home, '.codex', 'skills'), 'supacode-cli');
    seedSkill(path.join(home, '.agents', 'skills'), 'use-railway');

    await linkSkillsIntoCodexHome({ configDir, home });

    expect(listSkills(codexSkills(configDir))).toEqual(['supacode-cli']);
  });

  it('removes a link that became redundant when the neutral copy appeared', async () => {
    const { configDir, home } = sandbox();
    seedSkill(path.join(home, '.codex', 'skills'), 'use-railway');
    await linkSkillsIntoCodexHome({ configDir, home });
    expect(listSkills(codexSkills(configDir))).toEqual(['use-railway']);

    // Installed into the neutral directory afterwards; Codex now reads it there,
    // so our link is a duplicate and has to come back out.
    seedSkill(path.join(home, '.agents', 'skills'), 'use-railway');
    await linkSkillsIntoCodexHome({ configDir, home });

    expect(listSkills(codexSkills(configDir))).toEqual([]);
  });

  it('removes a link whose skill was uninstalled', async () => {
    const { configDir, home } = sandbox();
    const source = path.join(home, '.codex', 'skills');
    seedSkill(source, 'use-railway');
    seedSkill(source, 'going-away');
    await linkSkillsIntoCodexHome({ configDir, home });
    expect(listSkills(codexSkills(configDir))).toEqual(['going-away', 'use-railway']);

    rmSync(path.join(source, 'going-away'), { recursive: true });
    await linkSkillsIntoCodexHome({ configDir, home });

    expect(listSkills(codexSkills(configDir))).toEqual(['use-railway']);
  });

  it('clears a dangling link left behind by anything', async () => {
    const { configDir, home } = sandbox();
    seedSkill(path.join(home, '.codex', 'skills'), 'use-railway');
    mkdirSync(codexSkills(configDir), { recursive: true });
    symlinkSync(path.join(home, 'gone'), path.join(codexSkills(configDir), 'stale'), 'dir');

    await linkSkillsIntoCodexHome({ configDir, home });

    expect(listSkills(codexSkills(configDir))).toEqual(['use-railway']);
  });

  it('does nothing when the profile points at the user’s own Codex home', async () => {
    const { home } = sandbox();
    const configDir = path.join(home, '.codex');
    seedSkill(path.join(configDir, 'skills'), 'use-railway');

    await linkSkillsIntoCodexHome({ configDir, home });

    // Still exactly one real skill, and emphatically not a link to itself.
    expect(listSkills(codexSkills(configDir))).toEqual(['use-railway']);
    expect(() => readlinkSync(path.join(codexSkills(configDir), 'use-railway'))).toThrow();
  });

  it('creates nothing when there is nothing to link', async () => {
    const { configDir, home } = sandbox();

    await linkSkillsIntoCodexHome({ configDir, home });

    expect(readdirSync(configDir)).toEqual([]);
  });

  it('does not fail a run when the links cannot be written', async () => {
    const { home } = sandbox();
    seedSkill(path.join(home, '.codex', 'skills'), 'use-railway');
    // A `CODEX_HOME` whose `skills` name is occupied by a file.
    const configDir = path.join(home, 'occupied');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'skills'), 'not a directory');

    await expect(linkSkillsIntoCodexHome({ configDir, home })).resolves.toBeUndefined();
  });
});
