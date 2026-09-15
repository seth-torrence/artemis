/**
 * What an entry in a bank must contain, and the check of one entry against it.
 *
 * The `cerebro` schema is the one every existing bank uses and the one a bank
 * gets by saying nothing. A BANK.md may declare its own instead: which keys
 * are required, which values a type may take, how long a body may be. Both
 * arrive here as the same {@link BankSchemaSpec}, and one function checks a
 * file against whichever the bank chose — so a bank with a different shape
 * gets validation rather than being told it is not a bank.
 */

import { scanContent, type FrontmatterDocument } from './frontmatter.js';

/** The grammar of a memory's name, a bank's slug and an org or project. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One scope entry: a repository directory name, as a person types it. */
export const APPLIES_TO_ENTRY = /^[A-Za-z0-9_.-]+$/;

export interface BankSchemaSpec {
  /** Keys that must be present, dotted for nesting (`metadata.type`). */
  readonly required: readonly string[];
  /** The key that carries the entry's kind, dotted. `null` for a bank without kinds. */
  readonly typeKey: string | null;
  /** The kinds allowed, when the bank closes the set. */
  readonly types: readonly string[] | null;
  /** Kinds whose body has to carry `**Why:**` and `**How to apply:**`. */
  readonly explainedTypes: readonly string[];
  /** The key that scopes an entry to repositories, dotted. */
  readonly appliesToKey: string;
  readonly maxName: number;
  readonly maxDescription: number;
  readonly maxBody: number;
  /** The `name` must equal the file's stem. */
  readonly nameMatchesFile: boolean;
  /** Only the keys the schema names may appear at the top level. */
  readonly strictKeys: boolean;
  /** Top-level keys allowed under `strictKeys`. */
  readonly knownKeys: readonly string[];
  /**
   * A CRLF file is a problem rather than a fact.
   *
   * Off for the `cerebro` schema, although the CLI has such a rule: Python's
   * text mode normalises line endings on read, so the CLI never meets a
   * carriage return in a file on disk and the rule only ever fires on text
   * handed to it some other way. A Windows checkout with `core.autocrlf` has
   * CRLF in every file, and refusing those would refuse every bank on every
   * Windows machine that the CLI happily installs from. A manifest bank may
   * switch it on to insist.
   */
  readonly rejectCrlf: boolean;
}

/** The schema the `cerebro` CLI validates, pattern for pattern. */
export const CEREBRO_SCHEMA: BankSchemaSpec = {
  required: ['name', 'description', 'metadata.type'],
  typeKey: 'metadata.type',
  types: ['user', 'feedback', 'project', 'reference'],
  explainedTypes: ['feedback', 'project'],
  appliesToKey: 'metadata.applies_to',
  maxName: 60,
  maxDescription: 160,
  maxBody: 6000,
  nameMatchesFile: true,
  strictKeys: true,
  knownKeys: ['name', 'description', 'metadata'],
  rejectCrlf: false,
};

/** Read a dotted key out of a mapping. */
export function valueAt(data: Readonly<Record<string, unknown>>, dotted: string): unknown {
  let current: unknown = data;
  for (const part of dotted.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** What one file came to, before the adapter adds what only it knows. */
export interface CheckedEntry {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly type: string | null;
  readonly appliesTo: readonly string[];
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** The `applies_to` value as the CLI reads it: a list, or a string split on commas and spaces. */
export function appliesToEntries(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => asText(entry).trim()).filter((entry) => entry.length > 0);
  const text = asText(value).trim();
  return text.length === 0 ? [] : text.split(/[,\s]+/).filter((entry) => entry.length > 0);
}

/**
 * Check one parsed file against a schema.
 *
 * Problems make an entry uninstallable; warnings do not. That is the split
 * the CLI keeps between `validate` and `validate --strict`, and it is why a
 * memory with a relative date in it still reaches agents while the bank's CI
 * asks for the sentence to be fixed.
 */
export function checkEntry(
  document: FrontmatterDocument,
  fileStem: string,
  schema: BankSchemaSpec,
): CheckedEntry {
  const problems: string[] = [...document.problems];
  const warnings: string[] = [];
  const data = document.data ?? {};

  if (schema.rejectCrlf && document.crlf) {
    problems.push('file contains CR line endings; use LF');
  }
  if (schema.strictKeys && document.data !== null) {
    for (const key of Object.keys(document.data)) {
      if (!schema.knownKeys.includes(key)) problems.push(`unknown frontmatter key: ${key}`);
    }
  }
  for (const key of schema.required) {
    const value = valueAt(data, key);
    if (value === undefined || value === null || asText(value).trim().length === 0) {
      problems.push(`missing ${key}`);
    }
  }

  const rawName = asText(valueAt(data, 'name')).trim();
  const name = rawName.length > 0 ? rawName : fileStem;
  if (rawName.length > 0) {
    if (!SLUG_PATTERN.test(rawName)) problems.push('name must be kebab-case: lowercase letters, digits and hyphens');
    if (rawName.length > schema.maxName) problems.push(`name longer than ${String(schema.maxName)} chars`);
    if (schema.nameMatchesFile && rawName !== fileStem) {
      problems.push(`name ${rawName} does not match the filename ${fileStem}.md`);
    }
  }

  const description = asText(valueAt(data, 'description')).trim();
  if (description.length > schema.maxDescription) {
    problems.push(`description longer than ${String(schema.maxDescription)} chars`);
  }

  const body = document.body.trim();
  if (body.length === 0) problems.push('body is empty');
  if (body.length > schema.maxBody) {
    problems.push(`body longer than ${String(schema.maxBody)} chars — split into atomic memories`);
  }

  let type: string | null = null;
  if (schema.typeKey !== null) {
    const rawType = asText(valueAt(data, schema.typeKey)).trim();
    type = rawType.length > 0 ? rawType : null;
    if (type !== null && schema.types !== null && !schema.types.includes(type)) {
      problems.push(`type must be one of ${schema.types.join(', ')}`);
    }
    if (type !== null && schema.explainedTypes.includes(type)) {
      if (!body.includes('**Why:**') || !body.includes('**How to apply:**')) {
        warnings.push(`${type} memories should include **Why:** and **How to apply:** lines`);
      }
    }
  }

  const rawApplies = valueAt(data, schema.appliesToKey);
  const applies = appliesToEntries(rawApplies);
  let appliesTo: readonly string[] = [];
  if (applies !== null) {
    if (applies.length === 0) {
      problems.push(`${schema.appliesToKey} is present but empty — remove the key to mean everywhere`);
    }
    for (const entry of applies) {
      if (!APPLIES_TO_ENTRY.test(entry)) problems.push(`${schema.appliesToKey} entry ${entry} is not a directory name`);
    }
    appliesTo = applies;
  }

  const scan = scanContent(`${description}\n${body}`);
  problems.push(...scan.problems);
  warnings.push(...scan.warnings);

  return { name, description, body, type, appliesTo, problems, warnings };
}
