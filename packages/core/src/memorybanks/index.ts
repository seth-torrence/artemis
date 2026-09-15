/**
 * Team memory banks: what core knows about them.
 *
 * More than it used to, deliberately. The banks were driven by their own CLI
 * from the main process and core held only the credential store's shape and a
 * read of the CLI's registry. Now core reads a bank itself — in any of the
 * formats `formats.ts` knows — installs it into a project's memory, renders
 * the index a session loads, keeps the machine's registry with each bank's
 * profile scope, and describes the banks to the prompt renderer. Both hosts
 * (the desktop and the headless server) use the same reader, so a bank means
 * one thing on every machine that carries it.
 *
 * Nothing here spawns. Every function is file reads and writes, which is what
 * lets the desktop ask on the path of every run start and lets a machine with
 * no Python install and describe a bank.
 */

export * from './bankIndex.js';
export * from './describe.js';
export * from './formats.js';
export * from './frontmatter.js';
export * from './glob.js';
export * from './install.js';
export * from './manifest.js';
export * from './model.js';
export * from './prompt.js';
export * from './registry.js';
export * from './registryV2.js';
export * from './schema.js';
export * from './secrets.js';
export * from './sync.js';
