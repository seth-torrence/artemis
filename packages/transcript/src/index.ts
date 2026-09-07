/**
 * `@rx-artemis/transcript` — the transcript model, shared.
 *
 * Every Artemis front end has to turn the same `AgentEvent` stream into the
 * same rows: user turns, streamed assistant text, thinking, tool calls folded
 * into activity groups, permission cards, run ends. The desktop renderer solved
 * that once, framework-free, and the terminal UI needs the identical answer —
 * so the model lives here rather than in either app, where a second copy would
 * begin to drift the day it was pasted.
 *
 * ```
 * ┌── transcript ─────────────────────────────────────────────────────────┐
 * │ TranscriptModel   AgentEvent → immutable, reference-stable items,     │
 * │                   with per-token deltas coalesced onto one frame      │
 * │ frameScheduler    the display-clock flush a window wants              │
 * │ syncScheduler     the synchronous flush tests and headless code want  │
 * ├── tools ──────────────────────────────────────────────────────────────┤
 * │ classifyTool      a tool name → command / read / edit / search / …    │
 * │ describeActivity  counts → "Ran 36 commands, read 6 files"            │
 * ├── diff ───────────────────────────────────────────────────────────────┤
 * │ detectFileEdit    a tool call's arguments → the file edit it makes,   │
 * │                   diffed line- and character-wise under a cost cap    │
 * ├── format ─────────────────────────────────────────────────────────────┤
 * │ summarizeToolInput, formatTokens, formatUsd, formatDuration, …        │
 * └───────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Two rules hold for every module here, and the tsconfig enforces both:
 *
 *  1. **No Node.** `types` is empty. The renderer is a browser context and
 *     compiles without `@types/node`; a `process` or `fs` reference here would
 *     break it.
 *  2. **No framework.** Nothing imports React, Ink or the DOM. `DOM` is in the
 *     lib list purely so `requestAnimationFrame` resolves as a *name*; every
 *     use of it is behind a `typeof` guard and falls back to a timer.
 *
 * Types shared with everything else — events, capabilities, permissions — come
 * from `@rx-artemis/protocol`, and this package re-exports none of them.
 */

export * from './transcript.js';
export * from './tools.js';
export * from './diff.js';
export * from './format.js';
