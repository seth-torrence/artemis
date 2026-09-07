/**
 * The machine's memory banks, as the CLI's own files describe them.
 * ============================================================================
 *
 * Two hosts compose the memory-bank prompt for a run and both need the same
 * facts about each bank: where it is, whether this machine may write to it,
 * and how it wants to be filed. The desktop's main process had a reader of
 * its own; the headless server had none — so a served run could only ever be
 * told about the *client's* banks, in the client's paths, while the machine
 * it actually ran on had banks of its own that nothing described. The reader
 * lives here so both hosts read one set of files one way.
 *
 * Nothing here spawns. Every function is a synchronous read of a small file
 * or an `existsSync`, because two of the callers are on the path of every run
 * start. Writes to these files go through the `cerebro` CLI, which owns them:
 * this module mirrors the CLI's *reading* (`load_banks`, `load_bank_config`,
 * `bank_layout` and `is_bank` in `bin/cerebro`) and never its writing.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BANK SAYS ABOUT ITSELF
 * ---------------------------------------------------------------------------
 *
 * A bank is a git repository, and the repository is where its conventions
 * belong — not in a per-machine setting, and not in Artemis's source, which
 * must not know any bank in particular. So the facts that shape the prompt
 * are read out of the bank's own `cerebro.json`:
 *
 *  - `layout`: `flat` (memories under `memories/`, the shape every bank had
 *    before the key existed) or `projects` (each memory inside the project it
 *    belongs to, `projects/<org>/<project>/memories/`). A draft into a
 *    `projects` bank has to name an existing project, which is why the prompt
 *    teaches different flags for it.
 *  - `default_org`: what a draft is filed under when no org is named.
 *  - `instructions`: a markdown file, relative to the bank root, that the
 *    bank's maintainers wrote for agents. It is carried into the prompt
 *    verbatim — bounded, and only for a bank this machine may write to — so a
 *    bank can say how it wants to be read and written in its own words.
 *
 * Anything unrecognised reads as the pre-existing default, so a bank written
 * against a newer CLI never changes shape under an older Artemis, and an
 * older bank never changes shape under a newer one.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import type { MemoryBankPromptInfo } from '@rx-artemis/protocol';

/**
 * The slug the CLI gave the one bank it could manage before it could manage
 * several. Its installs live under a bare `memory/cerebro/` rather than
 * `memory/banks/<slug>/`, and its markers carry no slug — an address the CLI
 * keeps stable on purpose, so a machine that predates multi-bank migrates by
 * meaning nothing new.
 */
export const LEGACY_BANK_SLUG = 'cerebro';

/** The file at a bank's root that describes the bank. The CLI's own name for it. */
export const BANK_CONFIG_FILE = 'cerebro.json';

/**
 * How much of a bank's `instructions` file reaches the prompt.
 *
 * A bound rather than a refusal: a long file still says something useful in
 * its first pages, and cutting it with a note is what lets the bank's
 * maintainers see where the limit fell. Roughly a thousand tokens — a
 * contract, not a manual.
 */
export const BANK_INSTRUCTIONS_LIMIT = 4000;

/** How a bank arranges its memories. See the module note. */
export type BankLayout = 'flat' | 'projects';

/**
 * One bank as the CLI's config records it — including the pre-multi-bank
 * `{"bank": path}` shape, which reads as one enabled read-write bank under the
 * legacy slug.
 */
export interface RegistryBank {
  readonly slug: string;
  readonly path: string;
  readonly role: 'readwrite' | 'readonly';
  readonly enabled: boolean;
}

export interface BankRegistry {
  readonly banks: readonly RegistryBank[];
  /** The slug bare `cerebro` verbs address, or `null` when nothing is registered. */
  readonly defaultSlug: string | null;
}

/** What a bank's own `cerebro.json` says about it. Every field has a default. */
export interface BankConfig {
  readonly layout: BankLayout;
  readonly defaultOrg?: string;
  /** Relative path of the markdown file the bank wants agents to read. */
  readonly instructions?: string;
}

const EMPTY_REGISTRY: BankRegistry = { banks: [], defaultSlug: null };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* -------------------------------------------------------------------------- */
/* The registry: which banks this machine has                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where the CLI remembers the banks: `$XDG_CONFIG_HOME/cerebro/config.json`,
 * else `~/.config/cerebro/config.json`. The environment and home are
 * parameters so a test — or a host whose `HOME` is not the process owner's —
 * can ask about a different machine's file.
 */
export function registryPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const base = env['XDG_CONFIG_HOME'] ?? join(home, '.config');
  return join(base, 'cerebro', 'config.json');
}

/**
 * Where the single-bank era put the team bank. Still honoured: a machine with
 * a clone there and no registry keeps working, under the legacy slug.
 */
export function legacyBankRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const override = env['ARTEMIS_CEREBRO_ROOT'];
  if (override !== undefined && override.length > 0) return override;
  return join(home, 'Documents', 'cerebro');
}

/** Parse the registry file's text. Pure; the unit under test. */
export function parseRegistry(text: string): BankRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_REGISTRY;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_REGISTRY;
  const config = parsed as Record<string, unknown>;

  const raw = config['banks'];
  if (!Array.isArray(raw)) {
    const legacy = config['bank'];
    if (typeof legacy === 'string' && legacy.length > 0) {
      return {
        banks: [{ slug: LEGACY_BANK_SLUG, path: legacy, role: 'readwrite', enabled: true }],
        defaultSlug: LEGACY_BANK_SLUG,
      };
    }
    return EMPTY_REGISTRY;
  }

  const banks: RegistryBank[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const slug = item['slug'];
    const path = item['path'];
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) continue;
    if (typeof path !== 'string' || path.length === 0) continue;
    banks.push({
      slug,
      path,
      role: item['role'] === 'readonly' ? 'readonly' : 'readwrite',
      enabled: item['enabled'] !== false,
    });
  }
  const wanted = config['default'];
  const defaultSlug = banks.some((bank) => bank.slug === wanted)
    ? (wanted as string)
    : (banks[0]?.slug ?? null);
  return { banks, defaultSlug };
}

/** The registry on disk, or an empty one for a machine that has none. */
export function readRegistry(path: string = registryPath()): BankRegistry {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return EMPTY_REGISTRY;
  }
  return parseRegistry(text);
}

/* -------------------------------------------------------------------------- */
/* A bank's own description of itself                                         */
/* -------------------------------------------------------------------------- */

/**
 * Parse a bank's `cerebro.json`. Pure; tolerant in the CLI's own way — a
 * corrupt file, a missing key or a value of the wrong type reads as the
 * default, never as an error, because a bank that cannot describe itself is
 * still a bank.
 *
 * A BOM is tolerated for the reason the CLI tolerates one: PowerShell's
 * `Set-Content -Encoding utf8` writes it, and `JSON.parse` refuses it.
 */
export function parseBankConfig(text: string): BankConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { layout: 'flat' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { layout: 'flat' };
  }
  const record = parsed as Record<string, unknown>;
  const layout: BankLayout = record['layout'] === 'projects' ? 'projects' : 'flat';
  const defaultOrg = record['default_org'];
  const instructions = record['instructions'];
  return {
    layout,
    ...(typeof defaultOrg === 'string' && SLUG_PATTERN.test(defaultOrg) ? { defaultOrg } : {}),
    ...(typeof instructions === 'string' && instructions.trim().length > 0
      ? { instructions: instructions.trim() }
      : {}),
  };
}

/** A bank's config off disk. A bank without the file is a flat bank. */
export function readBankConfig(bankPath: string): BankConfig {
  let text: string;
  try {
    text = readFileSync(join(bankPath, BANK_CONFIG_FILE), 'utf8');
  } catch {
    return { layout: 'flat' };
  }
  return parseBankConfig(text);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Is this directory a bank? The CLI's own test, mirrored: a `memories/`
 * directory, or — for a bank whose `cerebro.json` declares the `projects`
 * layout — a `projects/` directory.
 *
 * Both halves matter. A `projects` bank is free to drop its empty `memories/`
 * folder once every machine reads the layout, and a host that still demanded
 * the folder would then stop seeing the bank: no prompt, no directory grant,
 * no sync — silently, since nothing would be wrong with the bank.
 */
export function isBank(path: string): boolean {
  if (isDirectory(join(path, 'memories'))) return true;
  return readBankConfig(path).layout === 'projects' && isDirectory(join(path, 'projects'));
}

/** The CLI a bank carries, when it carries one. Preferred over any other copy. */
export function embeddedCli(bankPath: string): string | null {
  const cli = join(bankPath, 'bin', 'cerebro');
  return existsSync(cli) ? cli : null;
}

/**
 * The bank's `instructions` file, ready for the prompt, or `undefined`.
 *
 * Read only from inside the bank: a relative path that escapes the root
 * (`../.ssh/config`) is refused rather than resolved, because the file is
 * named by a repository other people commit to. Bounded by
 * {@link BANK_INSTRUCTIONS_LIMIT}, and the cut is marked so the bank's
 * maintainers can see it fell.
 */
export function readBankInstructions(bankPath: string, config: BankConfig): string | undefined {
  if (config.instructions === undefined) return undefined;
  const root = resolve(bankPath);
  const file = resolve(root, config.instructions);
  if (file !== root && !file.startsWith(root + sep)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  } catch {
    return undefined;
  }
  if (text.length === 0) return undefined;
  if (text.length <= BANK_INSTRUCTIONS_LIMIT) return text;
  return (
    text.slice(0, BANK_INSTRUCTIONS_LIMIT).trimEnd() +
    `\n\n[… the bank's instructions continue; only the first ${String(BANK_INSTRUCTIONS_LIMIT)} characters are carried into the prompt.]`
  );
}

/* -------------------------------------------------------------------------- */
/* What a run should be told                                                  */
/* -------------------------------------------------------------------------- */

export interface BanksOnDiskOptions {
  readonly registry: BankRegistry;
  /**
   * Where the single-bank era's clone would be, for a machine with no
   * registry. Absent means "do not look" — a host that has no such history.
   */
  readonly legacyRoot?: string;
}

/**
 * The banks a run should know about: registered, enabled, present on disk.
 *
 * Registry first; a machine with no registry but the legacy clone gets that
 * clone, so pre-multi-bank machines keep working before their one-time
 * registration has run.
 */
export function banksOnDisk(options: BanksOnDiskOptions): RegistryBank[] {
  const { banks } = options.registry;
  if (banks.length > 0) {
    return banks.filter((bank) => bank.enabled && isBank(bank.path));
  }
  const root = options.legacyRoot;
  if (root !== undefined && isBank(root) && embeddedCli(root) !== null) {
    return [{ slug: LEGACY_BANK_SLUG, path: root, role: 'readwrite', enabled: true }];
  }
  return [];
}

export interface DescribeBanksOptions extends BanksOnDiskOptions {
  /**
   * The CLI to name for a bank that embeds none. A desktop passes the copy it
   * ships; a host with no such copy passes nothing and the prompt names the
   * bank-relative `bin/cerebro`, which is the honest fallback.
   */
  readonly fallbackCli?: string | null;
}

/**
 * The facts the prompt renderer needs, in composition's pure vocabulary.
 *
 * The default is resolved against the banks actually present: a registry
 * `default` naming a bank that is gone would leave every bank un-defaulted,
 * which the renderer reads as "no primary" — so the name it speaks and the
 * bank it drafts into would both change shape for a reason nobody chose.
 * Falling through to the first survivor makes a removal a promotion rather
 * than a hole.
 */
export function describeBanksForPrompt(options: DescribeBanksOptions): MemoryBankPromptInfo[] {
  const banks = banksOnDisk(options);
  const wanted = options.registry.defaultSlug;
  const resolvedDefault =
    wanted !== null && banks.some((bank) => bank.slug === wanted)
      ? wanted
      : (banks[0]?.slug ?? null);
  return banks.map((bank) => {
    const config = readBankConfig(bank.path);
    // A read-only bank is one this machine consumes and somebody else
    // maintains. Its notes are theirs to write and not this machine's to put
    // in front of its agents as standing text — consult its README instead.
    const instructions = bank.role === 'readonly' ? undefined : readBankInstructions(bank.path, config);
    return {
      slug: bank.slug,
      isDefault: bank.slug === resolvedDefault,
      readonly: bank.role === 'readonly',
      cli: embeddedCli(bank.path) ?? options.fallbackCli ?? 'bin/cerebro',
      layout: config.layout,
      ...(config.defaultOrg === undefined ? {} : { defaultOrg: config.defaultOrg }),
      ...(instructions === undefined ? {} : { instructions }),
    };
  });
}
