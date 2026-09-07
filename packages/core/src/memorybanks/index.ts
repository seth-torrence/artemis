/**
 * Team memory banks: the part of them core is allowed to know about.
 *
 * Little, deliberately. The banks are driven by their own CLI from the main
 * process (`apps/desktop/main/memoryBanks.ts` says why a second implementation
 * in TypeScript would drift), so core holds no bank *logic*. It holds two
 * things: the shape of the credential store main must inject (the encryption
 * behind it is Electron's, and core may not name Electron), and the read-only
 * view of the CLI's own files — which banks this machine has and how each
 * says it is filed — because every host that composes a run's prompt needs it,
 * and the headless server is a host.
 */

export * from './prompt.js';
export * from './registry.js';
export * from './secrets.js';
