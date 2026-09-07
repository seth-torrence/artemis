/**
 * Several conversations alive, one on screen.
 *
 * `app.tsx` holds a pool of `Conversation`s so that a turn can go on working
 * after the person has switched to another conversation — see the note there
 * on why the engine never needed the old one-at-a-time rule. These are the
 * two decisions the pool makes, kept pure so they can be pinned without a
 * renderer and so the component that uses them stays a wiring diagram.
 */

import type { ConversationStatus } from './conversation.js';
import type { RailActivity } from './components/Sidebar.js';

export interface Pruned<T> {
  /** Still alive, in a stable order, with `next` last if it was not already present. */
  readonly kept: readonly T[];
  /** To be disposed by the caller. */
  readonly dropped: readonly T[];
}

/**
 * Who survives a switch to `next`.
 *
 * The one being switched to always does. Of the rest, only a conversation
 * still working is worth keeping: an idle one's transcript is already in the
 * store and costs one read to bring back, whereas a working one's run is
 * still producing events that only it is listening for. Bounded by
 * construction — nothing idle accumulates.
 */
export function prunePool<T>(pool: readonly T[], next: T, isLive: (conversation: T) => boolean): Pruned<T> {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const conversation of pool) {
    if (conversation === next || isLive(conversation)) kept.push(conversation);
    else dropped.push(conversation);
  }
  if (!kept.includes(next)) kept.push(next);
  return { kept, dropped };
}

export interface ActivityInput {
  readonly sessionId?: string | undefined;
  readonly status: ConversationStatus;
  readonly pendingPermissions: readonly unknown[];
}

/**
 * What the rail says each conversation is doing, by session id.
 *
 * Read off the conversation's own status rather than asked of the registry:
 * between Enter and the provider's first event the run is `starting` and the
 * registry does not know it yet, so "is this run active" said no about a
 * conversation that was, to the person, plainly working. A question waiting
 * for an answer outranks running, because it is the one state a parked
 * conversation cannot get out of on its own.
 */
export function railActivityFor(conversations: Iterable<ActivityInput>): ReadonlyMap<string, RailActivity> {
  const map = new Map<string, RailActivity>();
  for (const { sessionId, status, pendingPermissions } of conversations) {
    if (sessionId === undefined) continue;
    if (pendingPermissions.length > 0) map.set(sessionId, 'awaiting');
    else if (status !== 'idle') map.set(sessionId, 'running');
  }
  return map;
}
