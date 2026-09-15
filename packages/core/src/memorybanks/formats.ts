/**
 * The format adapters: from a directory to a {@link ResolvedBank}, and from
 * that to a {@link Bank} with its entries read.
 *
 * Three formats are known, detected in this order:
 *
 *  - `manifest` — a `BANK.md` at the root. The bank says everything itself.
 *  - `legacy-projects` — a `cerebro.json` declaring `layout: projects`. The
 *    cortex shape: `projects/<org>/<project>/memories/`, with the 0.8.2 `root`
 *    key honoured so a tree called `brands/` reads too.
 *  - `legacy-flat` — a `memories/` directory and nothing else. The shape every
 *    bank had first, and the shape of the team bank Seth's machines carry.
 *
 * An adapter is a *description*: it produces globs, a scope function and a
 * schema, and one reader does the rest. Adding a format is adding a
 * description, not a second reader.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { parseFrontmatter } from './frontmatter.js';
import { listFiles } from './glob.js';
import {
  BANK_MANIFEST_FILE,
  compileScope,
  DEFAULT_INDEX_BUDGET,
  parseBankManifest,
  type BankManifest,
} from './manifest.js';
import type { Bank, BankEntry, BankFormat, ResolvedBank } from './model.js';
import { BANK_INSTRUCTIONS_LIMIT, embeddedCli, readBankConfig, readBankInstructions } from './registry.js';
import { CEREBRO_SCHEMA, checkEntry, SLUG_PATTERN, valueAt } from './schema.js';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The `root` a 0.8.2 `cerebro.json` names for its projects tree, else
 * `projects`. Only a bare slug is honoured, as the CLI honours it.
 */
export function legacyProjectsRoot(bankPath: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(bankPath, 'cerebro.json'), 'utf8').replace(/^﻿/, '')) as unknown;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const root = (raw as Record<string, unknown>)['root'];
      if (typeof root === 'string' && SLUG_PATTERN.test(root) && root !== 'memories') return root;
    }
  } catch {
    // No config, or one that does not parse: the default tree.
  }
  return 'projects';
}

/** What format a directory is kept in, or `null` when it is not a bank. */
export function detectBankFormat(path: string): BankFormat | null {
  if (!isDirectory(path)) return null;
  if (isFile(join(path, BANK_MANIFEST_FILE))) return 'manifest';
  if (readBankConfig(path).layout === 'projects' && isDirectory(join(path, legacyProjectsRoot(path)))) {
    return 'legacy-projects';
  }
  if (isDirectory(join(path, 'memories'))) return 'legacy-flat';
  return null;
}

/** A directory is a bank when a format claims it. Supersedes the two-format test. */
export function isBankDirectory(path: string): boolean {
  return detectBankFormat(path) !== null;
}

export interface ResolveBankOptions {
  /** The registry slug: the name a bank without a manifest is known by. */
  readonly slug: string;
  readonly instructionsLimit?: number;
}

function boundInstructions(text: string, limit: number): string | null {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= limit) return trimmed;
  return (
    trimmed.slice(0, limit).trimEnd() +
    `\n\n[… the bank's instructions continue; only the first ${String(limit)} characters are carried into the prompt.]`
  );
}

/** A file inside the bank, read and bounded, or `null`. Refuses a path that escapes the root. */
function readInside(root: string, relative: string, limit: number): string | null {
  const base = resolve(root);
  const file = resolve(base, relative);
  if (file !== base && !file.startsWith(base + sep)) return null;
  try {
    return boundInstructions(readFileSync(file, 'utf8'), limit);
  } catch {
    return null;
  }
}

function fromManifest(root: string, manifest: BankManifest, body: string, problems: readonly string[], options: ResolveBankOptions): ResolvedBank {
  const limit = options.instructionsLimit ?? BANK_INSTRUCTIONS_LIMIT;
  const scope = compileScope(manifest.scopeTemplate);
  const instructions =
    manifest.instructionsFile !== null
      ? readInside(root, manifest.instructionsFile, limit)
      : boundInstructions(body, limit);
  return {
    root,
    format: 'manifest',
    name: manifest.name.length > 0 ? manifest.name : options.slug,
    description: manifest.description,
    instructions,
    memories: {
      globs: manifest.memoryGlobs,
      levels: scope.levels,
      scopeOf: scope.scopeOf,
      schema: manifest.schema,
      place: manifest.place,
    },
    docGlobs: manifest.docGlobs,
    indexFile: manifest.indexFile,
    landing: manifest.landing,
    merge: manifest.merge,
    indexBudget: manifest.indexBudget,
    cli: embeddedCli(root),
    problems,
  };
}

function fromLegacyProjects(root: string, options: ResolveBankOptions): ResolvedBank {
  const config = readBankConfig(root);
  const tree = legacyProjectsRoot(root);
  const scope = compileScope(`${tree}/{org}/{project}/memories/`);
  const instructions = readBankInstructions(root, config) ?? null;
  return {
    root,
    format: 'legacy-projects',
    name: options.slug,
    description: null,
    instructions,
    memories: {
      globs: [`${tree}/*/*/memories/**/*.md`],
      levels: scope.levels,
      scopeOf: scope.scopeOf,
      schema: CEREBRO_SCHEMA,
      place: `${tree}/{org}/{project}/memories/{name}.md`,
    },
    docGlobs: [`${tree}/*/*/PROJECT.md`, `${tree}/*/*/HANDOFF.md`, `${tree}/*/*/PLAN.md`],
    indexFile: isFile(join(root, 'INDEX.md')) ? 'INDEX.md' : null,
    landing: 'pull-request',
    merge: 'auto',
    indexBudget: DEFAULT_INDEX_BUDGET,
    cli: embeddedCli(root),
    problems: [],
  };
}

/**
 * The flat layout's scope is positional: nothing for a file at the top of
 * `memories/`, an org for one directory down, an org and a project below
 * that, with deeper levels folding into the project name — the CLI's own
 * reading of the tree.
 */
function flatScopeOf(relativePath: string): Readonly<Record<string, string>> {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  const inside = parts.slice(1, -1);
  if (inside.length === 0) return {};
  const org = inside[0] ?? '';
  if (inside.length === 1) return { org };
  return { org, project: inside.slice(1).join('/') };
}

function fromLegacyFlat(root: string, options: ResolveBankOptions): ResolvedBank {
  const config = readBankConfig(root);
  return {
    root,
    format: 'legacy-flat',
    name: options.slug,
    description: null,
    instructions: readBankInstructions(root, config) ?? null,
    memories: {
      globs: ['memories/**/*.md'],
      levels: ['org', 'project'],
      scopeOf: flatScopeOf,
      schema: CEREBRO_SCHEMA,
      place: 'memories/{name}.md',
    },
    docGlobs: [],
    indexFile: null,
    landing: 'pull-request',
    merge: 'auto',
    indexBudget: DEFAULT_INDEX_BUDGET,
    cli: embeddedCli(root),
    problems: [],
  };
}

/** Describe a bank from what is at its root, or `null` when nothing claims it. */
export function resolveBank(path: string, options: ResolveBankOptions): ResolvedBank | null {
  const root = resolve(path);
  const format = detectBankFormat(root);
  if (format === null) return null;
  if (format === 'manifest') {
    let text: string;
    try {
      text = readFileSync(join(root, BANK_MANIFEST_FILE), 'utf8');
    } catch {
      return null;
    }
    const parsed = parseBankManifest(text);
    if (parsed.manifest === null) {
      // A manifest that does not read is still a bank — one that says so. The
      // cerebro defaults apply and the problems travel with it to the pane.
      return {
        ...fromLegacyFlat(root, options),
        format: 'manifest',
        problems: parsed.problems,
      };
    }
    return fromManifest(root, parsed.manifest, parsed.body, parsed.problems, options);
  }
  if (format === 'legacy-projects') return fromLegacyProjects(root, options);
  return fromLegacyFlat(root, options);
}

/** The name as a heading, the way the CLI titles an index line. */
export function titleOf(name: string): string {
  return name
    .replace(/-/g, ' ')
    .replace(/([A-Za-z])([A-Za-z]*)/g, (_match, first: string, rest: string) => first.toUpperCase() + rest.toLowerCase());
}

function readEntry(bank: ResolvedBank, file: string): BankEntry {
  let text: string;
  try {
    text = readFileSync(join(bank.root, file), 'utf8');
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    return {
      name: fileStem(file),
      title: titleOf(fileStem(file)),
      description: '',
      body: '',
      file,
      scope: bank.memories.scopeOf(file),
      type: null,
      added: null,
      author: null,
      appliesTo: [],
      data: null,
      problems: [`could not read: ${said}`],
      warnings: [],
    };
  }
  const document = parseFrontmatter(text);
  const checked = checkEntry(document, fileStem(file), bank.memories.schema);
  const scope = bank.memories.scopeOf(file);
  const problems = [...checked.problems];
  // In the projects layout the folder is the truth and a frontmatter that
  // disagrees is a file moved without being re-filed — the CLI's rule, kept
  // so a file this reader installs is one the bank's own gate accepts.
  if (bank.format === 'legacy-projects' && document.data !== null) {
    for (const level of bank.memories.levels) {
      const said = valueAt(document.data, `metadata.${level}`);
      const have = scope[level];
      if (typeof said === 'string' && have !== undefined && said !== have) {
        problems.push(`frontmatter ${level}: ${said} but the file sits under ${have} — move the file or fix the key`);
      }
    }
  }
  const data = document.data;
  const added = data === null ? undefined : valueAt(data, 'metadata.added') ?? valueAt(data, 'added');
  const author = data === null ? undefined : valueAt(data, 'metadata.author') ?? valueAt(data, 'author');
  return {
    name: checked.name,
    title: titleOf(checked.name),
    description: checked.description,
    body: checked.body,
    file,
    scope,
    type: checked.type,
    added: typeof added === 'string' ? added : added instanceof Date ? added.toISOString().slice(0, 10) : null,
    author: typeof author === 'string' ? author : null,
    appliesTo: checked.appliesTo,
    data,
    problems,
    warnings: checked.warnings,
  };
}

function fileStem(file: string): string {
  const base = file.split('/').at(-1) ?? file;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * Read every entry a resolved bank declares.
 *
 * Names are unique across the whole bank because installs flatten to
 * `<name>.md`. When two files claim one name the shallowest path wins and the
 * other carries a problem naming the winner — the CLI's tie-break, so the two
 * agree about which copy an agent meets.
 */
export function readBank(resolved: ResolvedBank): Bank {
  const files = listFiles(resolved.root, resolved.memories.globs);
  const entries = files.map((file) => readEntry(resolved, file));
  const winners = new Map<string, BankEntry>();
  const ranked = [...entries].sort((a, b) => {
    const depth = a.file.split('/').length - b.file.split('/').length;
    return depth !== 0 ? depth : a.file.localeCompare(b.file);
  });
  for (const entry of ranked) {
    if (entry.problems.length > 0) continue;
    if (!winners.has(entry.name)) winners.set(entry.name, entry);
  }
  const resolvedEntries = entries.map((entry) => {
    const winner = winners.get(entry.name);
    if (winner === undefined || winner.file === entry.file || entry.problems.length > 0) return entry;
    return { ...entry, problems: [`duplicate name ${entry.name}: ${winner.file} is the one installed`] };
  });
  const docs = resolved.docGlobs.length > 0 ? listFiles(resolved.root, resolved.docGlobs) : [];
  return { ...resolved, entries: resolvedEntries, docs };
}

/** Resolve and read in one step. `null` when the path is not a bank. */
export function readBankAt(path: string, options: ResolveBankOptions): Bank | null {
  const resolved = resolveBank(path, options);
  return resolved === null ? null : readBank(resolved);
}

/** Does a bank-relative file exist? For callers that hold a `Bank` and want its index or a doc. */
export function bankFileExists(bank: ResolvedBank, relative: string): boolean {
  return existsSync(join(bank.root, relative));
}
