/**
 * `BANK.md` — a bank describing itself.
 *
 * One file at the root. The frontmatter is the machine-readable half: where
 * the memories are, what the folder names mean, what an entry must contain,
 * where a new one is filed and how it lands. The body is the bank's own
 * instructions to agents, carried into the prompt as the `instructions` file
 * used to be. A bank that says only `name` and `description` gets the
 * `cerebro` defaults for everything else, so the smallest useful manifest is
 * two lines.
 *
 * Unknown keys are ignored rather than refused, the way the emerging AGENTS.md
 * and agent-skills conventions read their frontmatter: a bank written against
 * a newer Artemis keeps working under this one, and a bank is free to keep
 * keys of its own under a name it chooses.
 */

import { parseFrontmatter } from './frontmatter.js';
import type { BankLanding, BankMerge, IndexBudget } from './model.js';
import { CEREBRO_SCHEMA, type BankSchemaSpec } from './schema.js';

export const BANK_MANIFEST_FILE = 'BANK.md';

/**
 * What a project's memory file carries of one bank when nothing says
 * otherwise. Claude Code loads the first 200 lines or 25 KB of that file and
 * drops the rest, so this is most of that allowance: a machine with one bank
 * keeps nearly all of its index, and a host with several divides the
 * allowance between them (see `installBankEverywhere`'s `budget`).
 */
export const DEFAULT_INDEX_BUDGET: IndexBudget = { lines: 150, bytes: 20_000 };

export interface BankManifest {
  readonly name: string;
  readonly description: string | null;
  readonly memoryGlobs: readonly string[];
  /** A scope template such as `brands/{brand}/{system}/`, or `null` for unscoped. */
  readonly scopeTemplate: string | null;
  readonly schema: BankSchemaSpec;
  readonly docGlobs: readonly string[];
  readonly indexFile: string | null;
  /** A file to read instructions from instead of the body. */
  readonly instructionsFile: string | null;
  readonly place: string | null;
  readonly landing: BankLanding;
  readonly merge: BankMerge;
  readonly indexBudget: IndexBudget;
}

export interface ParsedManifest {
  readonly manifest: BankManifest | null;
  /** The body: the bank's instructions to agents. */
  readonly body: string;
  readonly problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  }
  return [];
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * An inline schema, on top of the cerebro one.
 *
 * ```yaml
 * schema:
 *   required: [name, description]
 *   types: [fact, decision, howto]
 *   type_key: type
 *   limits: { body: 8000 }
 *   strict: false
 * ```
 */
function parseSchema(value: unknown, problems: string[]): BankSchemaSpec {
  if (value === undefined || value === null || value === 'cerebro') return CEREBRO_SCHEMA;
  if (!isRecord(value)) {
    problems.push('schema must be "cerebro" or a mapping');
    return CEREBRO_SCHEMA;
  }
  const limits = isRecord(value['limits']) ? value['limits'] : {};
  const required = stringList(value['required']);
  const typeKey = value['type_key'] === null ? null : (optionalText(value['type_key']) ?? 'type');
  const types = value['types'] === undefined ? null : stringList(value['types']);
  const strict = value['strict'] === true;
  const known = stringList(value['known_keys']);
  return {
    required: required.length > 0 ? required : ['name', 'description'],
    typeKey,
    types: types !== null && types.length > 0 ? types : null,
    explainedTypes: stringList(value['explained_types']),
    appliesToKey: optionalText(value['applies_to_key']) ?? 'applies_to',
    maxName: positiveInt(limits['name'], CEREBRO_SCHEMA.maxName),
    maxDescription: positiveInt(limits['description'], CEREBRO_SCHEMA.maxDescription),
    maxBody: positiveInt(limits['body'], CEREBRO_SCHEMA.maxBody),
    nameMatchesFile: value['name_matches_file'] !== false,
    strictKeys: strict,
    knownKeys: strict ? (known.length > 0 ? known : ['name', 'description', 'metadata']) : [],
    rejectCrlf: value['reject_crlf'] === true,
  };
}

/** Read a manifest's text. Pure; the unit under test. */
export function parseBankManifest(text: string): ParsedManifest {
  const document = parseFrontmatter(text);
  const problems: string[] = [...document.problems];
  const data = document.data;
  if (data === null) {
    return { manifest: null, body: document.body, problems };
  }
  const name = optionalText(data['name']);
  if (name === null) problems.push('BANK.md needs a name');

  const memories = data['memories'];
  let memoryGlobs: string[] = [];
  let scopeTemplate: string | null = null;
  let schema = CEREBRO_SCHEMA;
  let place: string | null = null;
  if (typeof memories === 'string' || Array.isArray(memories)) {
    memoryGlobs = stringList(memories);
  } else if (isRecord(memories)) {
    memoryGlobs = [...stringList(memories['glob']), ...stringList(memories['globs'])];
    scopeTemplate = optionalText(memories['scope']);
    schema = parseSchema(memories['schema'], problems);
  } else if (memories !== undefined && memories !== null) {
    problems.push('memories must be a glob, a list of globs, or a mapping');
  }
  if (memoryGlobs.length === 0) memoryGlobs = ['memories/**/*.md'];
  if (scopeTemplate !== null && !/^(?:[A-Za-z0-9_.-]+|\{[a-z][a-z0-9_-]*\})(?:\/(?:[A-Za-z0-9_.-]+|\{[a-z][a-z0-9_-]*\}))*\/?$/.test(scopeTemplate)) {
    problems.push('memories.scope must be path segments, each a literal or a {label}');
    scopeTemplate = null;
  }

  const docs = data['docs'];
  const docGlobs = isRecord(docs) ? [...stringList(docs['glob']), ...stringList(docs['globs'])] : stringList(docs);

  const write = isRecord(data['write']) ? data['write'] : {};
  place = optionalText(write['place']);
  const rawLanding = optionalText(write['land']);
  const landing: BankLanding =
    rawLanding === 'commit' || rawLanding === 'none' || rawLanding === 'pull-request' ? rawLanding : 'pull-request';
  if (rawLanding !== null && landing !== rawLanding) problems.push('write.land must be pull-request, commit or none');
  const rawMerge = optionalText(write['merge']);
  const merge: BankMerge = rawMerge === 'review' ? 'review' : 'auto';

  const budget = isRecord(data['budget']) ? data['budget'] : {};
  const indexBudget: IndexBudget = {
    lines: positiveInt(budget['lines'], DEFAULT_INDEX_BUDGET.lines),
    bytes: positiveInt(budget['bytes'], DEFAULT_INDEX_BUDGET.bytes),
  };

  return {
    manifest: {
      name: name ?? '',
      description: optionalText(data['description']),
      memoryGlobs,
      scopeTemplate,
      schema,
      docGlobs,
      indexFile: optionalText(data['index']),
      instructionsFile: optionalText(data['instructions']),
      place,
      landing,
      merge,
      indexBudget,
    },
    body: document.body,
    problems,
  };
}

export interface CompiledScope {
  readonly levels: readonly string[];
  readonly scopeOf: (relativePath: string) => Readonly<Record<string, string>>;
}

/**
 * Turn `brands/{brand}/{system}/` into a function from a path to its labels.
 *
 * Matched as a prefix, segment by segment: a literal must equal the path's
 * segment, a `{label}` captures it. A path the template does not fit is
 * unscoped rather than an error — the glob decided it was a memory; the
 * template only says what its folders are called.
 */
export function compileScope(template: string | null): CompiledScope {
  if (template === null) return { levels: [], scopeOf: () => ({}) };
  const segments = template.split('/').filter((segment) => segment.length > 0);
  const levels = segments
    .filter((segment) => segment.startsWith('{'))
    .map((segment) => segment.slice(1, -1));
  return {
    levels,
    scopeOf: (relativePath) => {
      const parts = relativePath.replace(/\\/g, '/').split('/');
      const scope: Record<string, string> = {};
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i] ?? '';
        const part = parts[i];
        if (part === undefined) return {};
        if (segment.startsWith('{')) {
          scope[segment.slice(1, -1)] = part;
        } else if (segment !== part) {
          return {};
        }
      }
      return scope;
    },
  };
}

/** The manifest Artemis writes for a new bank, with the cerebro defaults spelled out. */
export function bankManifestTemplate(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    'memories:',
    '  glob: memories/**/*.md',
    '  schema: cerebro',
    'write:',
    '  place: memories/{name}.md',
    '  land: pull-request',
    '  merge: auto',
    '---',
    '',
    '# How agents use this bank',
    '',
    '- One fact per memory, with a description written as a retrieval hook:',
    '  when is this relevant?',
    '- Absolute dates only. Name repositories and systems explicitly.',
    '- Secrets never enter this bank. Name where a secret lives instead.',
    '- Say how a claim is known: measured, reported, or a hypothesis.',
    '',
  ].join('\n');
}
