/**
 * What the user installed, delivered to a run.
 *
 * Skills, slash commands and marketplace plugins live in the user's own
 * directories and are gated out of a session by design (`settingSources: []`);
 * this module builds the one channel that lets exactly the wanted surfaces
 * through, for every host — the desktop, the terminal, the server — from one
 * implementation. `bridge.ts` says why each provider needs a different shape.
 */

export * from './bridge.js';
