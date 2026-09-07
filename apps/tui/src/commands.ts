/**
 * Slash commands, parsed.
 *
 * The composer's one piece of grammar. A message that begins with `/` and a
 * word the TUI knows is a command for the TUI; anything else — including a
 * `/command` the TUI does *not* know — is sent to the agent verbatim, because
 * providers have slash commands of their own (`/compact`, a project's custom
 * skills) and swallowing them here would make those unreachable.
 *
 * Pure, so the tests can be exhaustive and the composer can be dumb.
 */

export type CommandName =
  | 'profile'
  | 'model'
  | 'mode'
  | 'resume'
  | 'attach'
  | 'tasks'
  | 'usage'
  | 'cwd'
  | 'new'
  | 'help'
  | 'quit';

export interface Command {
  readonly name: CommandName;
  /** Everything after the command word, trimmed. Empty when there was nothing. */
  readonly args: string;
}

export interface CommandSpec {
  readonly name: CommandName;
  readonly usage: string;
  readonly summary: string;
}

/** The menu, in the order `/help` prints it. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'profile', usage: '/profile', summary: 'Switch the account the next conversation runs as' },
  { name: 'model', usage: '/model', summary: 'Choose the model, and its effort where it has one' },
  { name: 'mode', usage: '/mode', summary: 'Set the permission mode for the next turn' },
  { name: 'resume', usage: '/resume', summary: 'Pick up a stored conversation from this directory' },
  { name: 'attach', usage: '/attach <path>', summary: 'Send an image or file with the next message' },
  { name: 'tasks', usage: '/tasks', summary: 'Background work: what is running, and what a delegated agent did' },
  { name: 'usage', usage: '/usage', summary: "The account's plan windows and how full they are" },
  { name: 'cwd', usage: '/cwd', summary: 'Choose where to work: a folder you have used, or browse for one' },
  { name: 'new', usage: '/new', summary: 'Start a fresh conversation on the same account' },
  { name: 'help', usage: '/help', summary: 'List these commands' },
  { name: 'quit', usage: '/quit', summary: 'Leave' },
];

const NAMES = new Set<string>(COMMANDS.map((command) => command.name));

/** `/exit` and `/q` mean `/quit`; nobody should have to remember which. */
const ALIASES: Readonly<Record<string, CommandName>> = {
  exit: 'quit',
  q: 'quit',
  models: 'model',
  profiles: 'profile',
  account: 'profile',
  permissions: 'mode',
  permission: 'mode',
  clear: 'new',
  '?': 'help',
  sessions: 'resume',
  history: 'resume',
  continue: 'resume',
  task: 'tasks',
  bg: 'tasks',
  // Not `plan`: that is the provider's own command (Claude Code's plan mode),
  // and aliasing it here to a plan-*limits* readout swallowed it.
  limits: 'usage',
  file: 'attach',
  image: 'attach',
};

/**
 * Parse a composer submission.
 *
 * Returns the command when the text is one the TUI owns, `null` otherwise.
 * Leading whitespace is tolerated; a lone `/` is not a command; case does not
 * matter for the word but is preserved in the arguments.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return null;
  const word = (match[1] ?? '').toLowerCase();
  const name = NAMES.has(word) ? (word as CommandName) : ALIASES[word];
  if (name === undefined) return null;
  return { name, args: (match[2] ?? '').trim() };
}

/**
 * Commands whose name starts with what has been typed so far — for the hint
 * line under the composer. An empty prefix lists everything.
 */
export function completeCommand(prefix: string): readonly CommandSpec[] {
  const needle = prefix.replace(/^\//, '').toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(needle));
}

/**
 * The provider's own commands that match what has been typed — matched on the
 * name a person would think of.
 *
 * A bridged skill arrives fully qualified: `artemis-skills:code-review`. Nobody
 * reaches for that by typing the marketplace's name first, and matching only
 * on the whole string means the rows a user is actually looking for are
 * unreachable unless they already know which plugin owns them. So the part
 * after the colon matches too, and a whole-name match sorts first because
 * someone who did type the prefix meant it.
 */
export function completeProviderCommand(prefix: string, commands: readonly string[]): readonly string[] {
  const needle = prefix.replace(/^\//, '').toLowerCase();
  const whole: string[] = [];
  const suffix: string[] = [];
  for (const name of commands) {
    const lower = name.toLowerCase();
    if (lower.startsWith(needle)) whole.push(name);
    else if (lower.slice(lower.indexOf(':') + 1).startsWith(needle)) suffix.push(name);
  }
  return [...whole, ...suffix];
}
