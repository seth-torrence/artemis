/**
 * One model for every bank, whatever format it is kept in.
 *
 * A format adapter (`formats.ts`) turns a directory into a {@link ResolvedBank}
 * — where the entries are, what the folder names mean, what an entry must
 * contain, where a new one goes — and the reader turns that into a
 * {@link Bank} with its entries read and checked. Everything downstream (the
 * prompt, the index, the installer, the settings pane, the memory tools) works
 * on these two shapes and never on a layout, which is what lets a bank change
 * shape without Artemis changing.
 */

import type { BankSchemaSpec } from './schema.js';

/** How a bank is kept. Detected from what is at its root; see `formats.ts`. */
export type BankFormat = 'legacy-flat' | 'legacy-projects' | 'manifest';

/** How a new entry reaches the bank's remote. */
export type BankLanding = 'pull-request' | 'commit' | 'none';

/** What a landed pull request does next. */
export type BankMerge = 'auto' | 'review';

/** How much of a bank's index a project's memory file carries. */
export interface IndexBudget {
  readonly lines: number;
  readonly bytes: number;
}

/**
 * Where a bank keeps its memories and how to read the path of one.
 *
 * `scopeOf` maps a bank-relative path to the labels its folders carry —
 * `{ org, project }` for a cortex-shaped bank, `{ brand, system }` for a
 * brand-first one, `{}` for a flat one — and `levels` names those labels in
 * order, so a prompt can say "filed by brand, then system" without knowing
 * either word in advance.
 */
export interface MemoriesSource {
  readonly globs: readonly string[];
  readonly levels: readonly string[];
  readonly scopeOf: (relativePath: string) => Readonly<Record<string, string>>;
  readonly schema: BankSchemaSpec;
  /** Where a new entry is written, as a template: `brands/{brand}/{system}/memories/{name}.md`. */
  readonly place: string | null;
}

export interface ResolvedBank {
  readonly root: string;
  readonly format: BankFormat;
  /** What the bank calls itself. The registry slug when it says nothing. */
  readonly name: string;
  /** One line on what it holds and when to use it, from its manifest. */
  readonly description: string | null;
  /** The bank's own words for agents, already bounded. */
  readonly instructions: string | null;
  readonly memories: MemoriesSource;
  /** Documents worth surfacing (entry points, handoffs), as patterns. */
  readonly docGlobs: readonly string[];
  /** A bank-provided index, relative to the root, when it keeps one. */
  readonly indexFile: string | null;
  readonly landing: BankLanding;
  readonly merge: BankMerge;
  readonly indexBudget: IndexBudget;
  /** The CLI the bank embeds, when it does — absolute path. */
  readonly cli: string | null;
  /** Why the bank could not be fully described, if anything was wrong with its manifest. */
  readonly problems: readonly string[];
}

export interface BankEntry {
  readonly name: string;
  /** The name as a heading: `hermes-fleet-on-mnl` → `Hermes Fleet On Mnl`. */
  readonly title: string;
  readonly description: string;
  readonly body: string;
  /** Bank-relative path with forward slashes — the stable identity. */
  readonly file: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly type: string | null;
  readonly added: string | null;
  readonly author: string | null;
  readonly appliesTo: readonly string[];
  /** The frontmatter as read, for re-rendering on install. `null` when it did not parse. */
  readonly data: Readonly<Record<string, unknown>> | null;
  /** Errors. An entry with any is browsable but never installed. */
  readonly problems: readonly string[];
  /** Advice. Installed regardless. */
  readonly warnings: readonly string[];
}

export interface Bank extends ResolvedBank {
  readonly entries: readonly BankEntry[];
  /** Documents matched by `docGlobs`, bank-relative. */
  readonly docs: readonly string[];
}

/** The entries that reach an agent: read cleanly and checked without error. */
export function installableEntries(bank: Bank): BankEntry[] {
  return bank.entries.filter((entry) => entry.problems.length === 0);
}
