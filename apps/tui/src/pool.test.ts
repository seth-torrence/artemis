/**
 * Several conversations alive, one on screen.
 *
 * The two rules `app.tsx` needs from the pool, kept pure so they can be pinned
 * without a renderer: which conversations survive a switch, and what the rail
 * says each one is doing.
 */

import { describe, expect, it } from 'vitest';

import { prunePool, railActivityFor } from './pool.js';

interface Fake {
  readonly name: string;
  readonly live: boolean;
}
const fake = (name: string, live = false): Fake => ({ name, live });
const isLive = (f: Fake): boolean => f.live;

describe('prunePool', () => {
  it('drops an idle conversation on the way out, and keeps a working one', () => {
    const idle = fake('idle');
    const working = fake('working', true);
    const next = fake('next');

    expect(prunePool([idle, working], next, isLive)).toEqual({ kept: [working, next], dropped: [idle] });
  });

  it('never drops the one being switched to, live or not, and never lists it twice', () => {
    const next = fake('next');
    const other = fake('other');

    // Switching back to a parked conversation must not duplicate it.
    expect(prunePool([other, next], next, isLive)).toEqual({ kept: [next], dropped: [other] });
  });
});

describe('railActivityFor', () => {
  it('marks a turn as running from the moment it is asked for, not from when the provider answers', () => {
    // Between Enter and the provider's first event the status is `starting`;
    // the registry does not yet know the run, so "is the run active" said no
    // and the rail showed nothing for a conversation that was, to the person,
    // plainly working.
    const activity = railActivityFor([
      { sessionId: 's1', status: 'starting', pendingPermissions: [] },
      { sessionId: 's2', status: 'running', pendingPermissions: [] },
      { sessionId: 's3', status: 'awaiting_permission', pendingPermissions: [{}] },
      { sessionId: 's4', status: 'idle', pendingPermissions: [] },
      { sessionId: undefined, status: 'running', pendingPermissions: [] },
    ]);

    expect([...activity.entries()]).toEqual([
      ['s1', 'running'],
      ['s2', 'running'],
      ['s3', 'awaiting'],
    ]);
  });
});
