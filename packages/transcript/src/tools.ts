/**
 * What a tool call *was*, in words.
 *
 * The transcript collapses a burst of tool calls into a single activity marker
 * — "Ran 36 commands, read 6 files, used a tool" — and this is where a tool
 * name becomes one of those clauses. Two consumers share it, which is why it
 * lives in `lib/` rather than beside either of them: the transcript model
 * counts calls by category when it builds a group, and the marker row picks an
 * icon per category when it draws one.
 *
 * Framework-free on purpose. Classification and phrasing are the parts most
 * likely to be wrong, and they are worth testing without mounting anything.
 *
 * ## Why a closed set of categories
 *
 * The alternative is one icon and one phrase per tool name, which cannot work:
 * tool names are provider vocabulary, not ours. Claude says `Bash` and `Edit`,
 * Codex says `shell` and `apply_patch`, and an MCP server says whatever it
 * likes. A closed category set is the only thing that survives a provider we
 * have not written yet — an unrecognised name lands in `other` and reads as
 * "used a tool", which is true and unembarrassing.
 */

/**
 * The kinds of work worth naming separately in a summary line.
 *
 * The test for membership is whether a reader scanning a long thread would want
 * these counted apart. `read` and `edit` are split because "read 6 files" and
 * "edited 6 files" are wildly different claims about what happened; `search`
 * and `command` are split because a grep is not a side effect and a shell
 * command might be.
 */
export type ToolCategory =
  | 'command'
  | 'read'
  | 'edit'
  | 'search'
  | 'web'
  | 'agent'
  | 'plan'
  | 'mcp'
  | 'other';

/**
 * Display order for clauses and icons.
 *
 * Roughly "most consequential first": something that changed the machine
 * outranks something that only looked at it. `other` is last because a clause
 * that says nothing specific should not lead the sentence.
 */
export const TOOL_CATEGORY_ORDER: readonly ToolCategory[] = [
  'command',
  'edit',
  'read',
  'search',
  'web',
  'agent',
  'plan',
  'mcp',
  'other',
];

/** Counts per category. Absent keys are zero. */
export type ActivityCounts = Readonly<Partial<Record<ToolCategory, number>>>;

/**
 * Tool name → category, keyed by {@link normalize}d name.
 *
 * Covers Claude's vocabulary and Codex's, because those are the two providers
 * with adapters. Anything unlisted is `other`, which is a working answer rather
 * than a gap — see the file header.
 */
const BY_NAME: Readonly<Record<string, ToolCategory>> = {
  // Shell.
  bash: 'command',
  bashoutput: 'command',
  killshell: 'command',
  killbash: 'command',
  shell: 'command',
  localshell: 'command',
  run: 'command',
  runcommand: 'command',

  // Reading.
  read: 'read',
  readfile: 'read',
  notebookread: 'read',
  viewimage: 'read',

  // Writing.
  write: 'edit',
  writefile: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  applypatch: 'edit',
  strreplace: 'edit',

  // Finding.
  glob: 'search',
  grep: 'search',
  ls: 'search',
  listdir: 'search',
  find: 'search',

  // The network.
  webfetch: 'web',
  websearch: 'web',
  fetch: 'web',

  // Delegation.
  task: 'agent',
  agent: 'agent',
  dispatchagent: 'agent',

  // Bookkeeping.
  todowrite: 'plan',
  updateplan: 'plan',
  exitplanmode: 'plan',
  taskcreate: 'plan',
  taskupdate: 'plan',
};

/**
 * Fold a provider's spelling into a lookup key.
 *
 * Case and separators are the only differences between `apply_patch`,
 * `applyPatch` and `ApplyPatch`, and all three mean the same thing. Normalising
 * them away is what lets one table cover several providers' house styles
 * without an entry per variant.
 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[_\-\s.]/g, '');
}

/**
 * Classify one tool call.
 *
 * The MCP check comes first and is a prefix test rather than a table lookup:
 * MCP tool names are `mcp__<server>__<tool>`, the `<tool>` half is arbitrary
 * third-party text, and a server exposing a tool it happens to call `read`
 * must not be counted as a file read by this app.
 */
export function classifyTool(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  return BY_NAME[normalize(name)] ?? 'other';
}

/* -------------------------------------------------------------------------- */
/* Phrasing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How each category says itself, finished and in flight.
 *
 * `{n}` is substituted with the count. Singular gets its own string rather than
 * a pluralisation rule because English does not cooperate: "searched the code
 * once" and "delegated to an agent" are not "…1 times" and "…1 agents" with the
 * number swapped in.
 *
 * All clauses are lowercase. The marker capitalises the first one it uses, so
 * the same clause reads correctly whether it leads the sentence or follows a
 * comma — storing them capitalised would make every clause after the first
 * wrong.
 */
const PHRASES: Readonly<
  Record<ToolCategory, { one: string; many: string; oneLive: string; manyLive: string }>
> = {
  command: {
    one: 'ran a command',
    many: 'ran {n} commands',
    oneLive: 'running a command',
    manyLive: 'running {n} commands',
  },
  edit: {
    one: 'edited a file',
    many: 'edited {n} files',
    oneLive: 'editing a file',
    manyLive: 'editing {n} files',
  },
  read: {
    one: 'read a file',
    many: 'read {n} files',
    oneLive: 'reading a file',
    manyLive: 'reading {n} files',
  },
  search: {
    one: 'searched the code',
    many: 'searched the code {n} times',
    oneLive: 'searching the code',
    manyLive: 'searching the code',
  },
  web: {
    one: 'fetched a page',
    many: 'fetched {n} pages',
    oneLive: 'fetching a page',
    manyLive: 'fetching {n} pages',
  },
  agent: {
    one: 'delegated to an agent',
    many: 'delegated to {n} agents',
    oneLive: 'delegating to an agent',
    manyLive: 'delegating to {n} agents',
  },
  plan: {
    one: 'updated the plan',
    many: 'updated the plan {n} times',
    oneLive: 'updating the plan',
    manyLive: 'updating the plan',
  },
  mcp: {
    one: 'called an MCP tool',
    many: 'called {n} MCP tools',
    oneLive: 'calling an MCP tool',
    manyLive: 'calling {n} MCP tools',
  },
  other: {
    one: 'used a tool',
    many: 'used {n} tools',
    oneLive: 'using a tool',
    manyLive: 'using {n} tools',
  },
};

/** The one clause for a single category, tense chosen by `live`. */
function clause(category: ToolCategory, n: number, live: boolean): string {
  const phrase = PHRASES[category];
  if (n === 1) return live ? phrase.oneLive : phrase.one;
  return (live ? phrase.manyLive : phrase.many).replace('{n}', String(n));
}

/**
 * Turn counts into the marker's summary line.
 *
 * `live` is one flag for the whole group rather than per clause: a group with
 * anything still running reads as present tense throughout, because mixing
 * ("ran 3 commands, reading a file") makes a single line describe two moments
 * in time and stops scanning cleanly.
 *
 * Returns `''` for an empty group, which the caller should treat as "draw
 * nothing" rather than rendering an empty marker.
 */
export function describeActivity(counts: ActivityCounts, live = false): string {
  const parts: string[] = [];
  for (const category of TOOL_CATEGORY_ORDER) {
    const n = counts[category] ?? 0;
    if (n > 0) parts.push(clause(category, n, live));
  }
  if (parts.length === 0) return '';
  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
