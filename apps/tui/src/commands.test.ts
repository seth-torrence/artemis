import { describe, expect, it } from 'vitest';

import { COMMANDS, completeCommand, parseCommand, completeProviderCommand } from './commands.js';

describe('parseCommand', () => {
  it('recognises every listed command by name', () => {
    for (const spec of COMMANDS) {
      expect(parseCommand(`/${spec.name}`)).toEqual({ name: spec.name, args: '' });
    }
  });

  it('keeps arguments, trimmed, with their case', () => {
    expect(parseCommand('/model  Fable  ')).toEqual({ name: 'model', args: 'Fable' });
    expect(parseCommand('/mode plan')).toEqual({ name: 'mode', args: 'plan' });
  });

  it('is case-insensitive on the word and tolerates leading whitespace', () => {
    expect(parseCommand('  /QUIT')).toEqual({ name: 'quit', args: '' });
  });

  it('resolves aliases', () => {
    expect(parseCommand('/exit')?.name).toBe('quit');
    expect(parseCommand('/q')?.name).toBe('quit');
    expect(parseCommand('/?')?.name).toBe('help');
    expect(parseCommand('/account')?.name).toBe('profile');
  });

  it("leaves messages and the provider's own slash commands alone", () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/compact')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/ model')).toBeNull();
    expect(parseCommand('a /model')).toBeNull();
  });
});

describe('completeCommand', () => {
  it('lists everything for an empty prefix and narrows by name', () => {
    expect(completeCommand('')).toHaveLength(COMMANDS.length);
    expect(completeCommand('/mo').map((command) => command.name)).toEqual(['model', 'mode']);
    expect(completeCommand('zzz')).toEqual([]);
  });
});

/*
 * Reaching a bridged skill by the name a person thinks of.
 *
 * Skills arrive from the content bridge fully qualified — the marketplace's
 * name, a colon, then the command — and reported as "I cannot see my skills
 * when I type /". They were reachable, but only by typing the plugin's name
 * first, which is not how anyone looks for `code-review`.
 */
describe('completeProviderCommand', () => {
  const commands = ['deep-research', 'artemis-skills:code-review', 'artemis-skills:grilling', 'compact'];

  it('finds a skill by the part after the colon', () => {
    expect(completeProviderCommand('/code', commands)).toEqual(['artemis-skills:code-review']);
    expect(completeProviderCommand('/gril', commands)).toEqual(['artemis-skills:grilling']);
  });

  it('still matches the whole name, and puts those first', () => {
    expect(completeProviderCommand('/artemis-skills:gril', commands)).toEqual(['artemis-skills:grilling']);
    // `c` matches `compact` outright and `code-review` after its colon; the
    // one that matched as typed leads.
    expect(completeProviderCommand('/c', commands)).toEqual(['compact', 'artemis-skills:code-review']);
  });

  it('lists everything for a bare slash, and nothing for a miss', () => {
    expect(completeProviderCommand('/', commands)).toEqual(commands);
    expect(completeProviderCommand('/nothing-like-this', commands)).toEqual([]);
  });
});

describe('what is left for the provider', () => {
  it('does not swallow /plan, which is the provider’s own command', () => {
    // The file's rule: a `/command` the TUI does not own goes to the agent,
    // because providers have slash commands of their own. `/plan` was
    // aliased to `/usage` — a plan-*limits* readout — and Claude Code's real
    // `/plan` never arrived.
    expect(parseCommand('/plan')).toBeNull();
    expect(parseCommand('/plan add tests first')).toBeNull();
  });
});
