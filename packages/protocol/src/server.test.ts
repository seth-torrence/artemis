import { describe, expect, it } from 'vitest';

import type { ProfileId } from './ids.js';
import { reviewParameters } from './openai.js';
import {
  assignProfileSlugs,
  isValidServerPort,
  modelRoute,
  parseModelRoute,
  profileSlug,
  readChatExtensions,
  serverUrl,
} from './server.js';

const id = (value: string): ProfileId => value as ProfileId;

describe('profileSlug', () => {
  it('makes a label typeable', () => {
    expect(profileSlug('Work Max')).toBe('work-max');
    expect(profileSlug('  Personal (Pro)  ')).toBe('personal-pro');
    expect(profileSlug('team_alpha')).toBe('team-alpha');
  });

  it('returns nothing for a label with nothing usable in it', () => {
    // The empty answer is load-bearing: `assignProfileSlugs` falls back to the
    // id, which is always addressable, rather than inventing a generic name.
    expect(profileSlug('🎯')).toBe('');
    expect(profileSlug('   ')).toBe('');
  });
});

describe('assignProfileSlugs', () => {
  it('breaks collisions so a route can only mean one account', () => {
    const slugs = assignProfileSlugs([
      { id: id('a'), label: 'Work' },
      { id: id('b'), label: 'work ' },
      { id: id('c'), label: 'WORK' },
    ]);

    expect(slugs.get(id('a'))).toBe('work');
    expect(slugs.get(id('b'))).toBe('work-2');
    expect(slugs.get(id('c'))).toBe('work-3');
    // The property that actually matters — three accounts, three addresses.
    expect(new Set(slugs.values()).size).toBe(3);
  });

  it('falls back to the id when a label slugs to nothing', () => {
    const slugs = assignProfileSlugs([{ id: id('prof-42'), label: '🎯' }]);
    expect(slugs.get(id('prof-42'))).toBe('prof-42');
  });

  it('is stable for a stable input order', () => {
    const profiles = [
      { id: id('a'), label: 'Work' },
      { id: id('b'), label: 'Work' },
    ];
    expect([...assignProfileSlugs(profiles).values()]).toEqual([
      ...assignProfileSlugs(profiles).values(),
    ]);
  });
});

describe('parseModelRoute', () => {
  it('splits on the first separator only', () => {
    // An Ollama model id contains a slash. The account half never does, so the
    // first separator is the boundary and everything after it is the model.
    expect(parseModelRoute('local/library/llama3:8b')).toEqual({
      profile: 'local',
      model: 'library/llama3:8b',
    });
  });

  it('refuses a bare model id', () => {
    // Deliberate: a model without an account is not an address — two profiles
    // can offer the same model on different plans.
    expect(parseModelRoute('opus')).toBeUndefined();
  });

  it('refuses a half-empty route', () => {
    expect(parseModelRoute('/opus')).toBeUndefined();
    expect(parseModelRoute('work-max/')).toBeUndefined();
  });

  it('round-trips what modelRoute composes', () => {
    expect(parseModelRoute(modelRoute('work-max', 'opus'))).toEqual({
      profile: 'work-max',
      model: 'opus',
    });
  });
});

describe('serverUrl', () => {
  it('brackets an IPv6 literal so the port is still readable', () => {
    expect(serverUrl('127.0.0.1', 6472)).toBe('http://127.0.0.1:6472');
    expect(serverUrl('::1', 6472)).toBe('http://[::1]:6472');
  });
});

describe('readChatExtensions', () => {
  it('reads the two things only a remote client asks for', () => {
    expect(
      readChatExtensions({ artemis: { remote: { detach: true, permissions: true } } }),
    ).toEqual({ remote: { detach: true, permissions: true } });
  });

  it('leaves the block absent for a caller that asked for nothing', () => {
    // Load-bearing rather than tidy: everything downstream reads
    // `remote?.detach === true`, and a request that never mentioned it must
    // arrive as the old behaviour by construction.
    expect(readChatExtensions({ artemis: { sessionId: 'sess-1' } })).toEqual({
      sessionId: 'sess-1',
    });
    expect(readChatExtensions({})).toEqual({});
  });

  it('carries a requested permission mode, and drops a non-string one', () => {
    expect(readChatExtensions({ artemis: { permissionMode: 'acceptEdits' } })).toEqual({
      permissionMode: 'acceptEdits',
    });
    // The value is not validated against a mode list here on purpose: which
    // modes exist is the serving provider's fact, and the host is the one
    // that clamps against it. What this parser refuses is only the caller bug.
    expect(readChatExtensions({ artemis: { permissionMode: 7 } })).toEqual({});
  });

  it('carries appended standing instructions, and drops an empty or non-string one', () => {
    expect(readChatExtensions({ artemis: { systemPrompt: 'Follow the house style.' } })).toEqual({
      systemPrompt: 'Follow the house style.',
    });
    // Empty is not "instructions the caller chose"; it is nothing, and nothing
    // should not cost a prompt-cache round to say. A non-string is a caller bug.
    expect(readChatExtensions({ artemis: { systemPrompt: '' } })).toEqual({});
    expect(readChatExtensions({ artemis: { systemPrompt: 42 } })).toEqual({});
  });

  it('drops a remote block that says nothing it can act on', () => {
    // Same rule as every other field: unknown keys drop, wrong types drop, and
    // a client that meant it sends a boolean. Half-honouring `detach: 1` would
    // be worse than ignoring it.
    expect(readChatExtensions({ artemis: { remote: 'yes' } })).toEqual({});
    expect(readChatExtensions({ artemis: { remote: { detach: 1, later: true } } })).toEqual({});
    expect(readChatExtensions({ artemis: { remote: { detach: 'true', permissions: true } } })).toEqual(
      { remote: { permissions: true } },
    );
  });

  it('keeps the namespace out of the rejected parameter set', () => {
    // The extension travels inside `artemis`, which the policy honours — so a
    // request that opts in is not turned away as unsupported before it runs.
    const review = reviewParameters({
      model: 'work-max/opus',
      messages: [],
      artemis: { remote: { detach: true } },
    });
    expect(review.rejected).toEqual([]);
    expect(review.ignored).toEqual([]);
  });
});

describe('isValidServerPort', () => {
  it('accepts 0 as "any free port"', () => {
    expect(isValidServerPort(0)).toBe(true);
  });

  it('rejects the privileged range and anything not an integer', () => {
    expect(isValidServerPort(80)).toBe(false);
    expect(isValidServerPort(1024)).toBe(true);
    expect(isValidServerPort(65_535)).toBe(true);
    expect(isValidServerPort(65_536)).toBe(false);
    expect(isValidServerPort(6472.5)).toBe(false);
    expect(isValidServerPort(Number.NaN)).toBe(false);
  });
});
