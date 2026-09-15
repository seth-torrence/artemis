/**
 * Reading one memory file: the frontmatter, the body, and the scans every
 * bank's gate runs over both.
 *
 * Real YAML rather than the line-by-line reading the `cerebro` CLI does, and
 * tolerant of what a Windows checkout produces: a byte-order mark from
 * PowerShell, CRLF line endings from `core.autocrlf`. The CLI rejects a file
 * with a single carriage return in it; here a CRLF file reads the same as an
 * LF one and the fact is reported, so a bank that wants to insist can.
 *
 * The scans are the CLI's own, ported pattern for pattern so a file this
 * reader accepts is one the bank's CI (`bin/cerebro validate --strict`) will
 * accept too — plus one the CLI does not have: invisible Unicode. Zero-width
 * and bidirectional characters survive a pull-request review because a
 * rendered diff does not show them, and an instruction hidden in one is the
 * documented way a shared rules file gets poisoned.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface FrontmatterDocument {
  /** The frontmatter mapping, or `null` when the file has none it can read. */
  readonly data: Readonly<Record<string, unknown>> | null;
  /** Everything after the frontmatter, leading blank lines removed. */
  readonly body: string;
  /** Why `data` is `null`, when it is. */
  readonly problems: readonly string[];
  /** The file carried carriage returns. Read anyway; reported for banks that mind. */
  readonly crlf: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split a markdown file into its YAML frontmatter and body. */
export function parseFrontmatter(rawText: string): FrontmatterDocument {
  const crlf = rawText.includes('\r');
  const text = rawText.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) {
    return { data: null, body: text, problems: ['no frontmatter: the file must start with ---'], crlf };
  }
  const close = /\n---[ \t]*(?:\n|$)/.exec(text.slice(4));
  if (close === null) {
    return { data: null, body: text, problems: ['frontmatter never closes: no --- line after it'], crlf };
  }
  const header = text.slice(4, 4 + close.index);
  const body = text.slice(4 + close.index + close[0].length).replace(/^\n+/, '');
  let parsed: unknown;
  try {
    parsed = parseYaml(header, { uniqueKeys: true });
  } catch (error) {
    const said = error instanceof Error ? error.message.split('\n')[0] ?? 'unreadable' : 'unreadable';
    return { data: null, body, problems: [`frontmatter is not valid YAML: ${said}`], crlf };
  }
  if (!isRecord(parsed)) {
    return { data: null, body, problems: ['frontmatter must be a mapping of keys to values'], crlf };
  }
  return { data: parsed, body, problems: [], crlf };
}

/** The file text for a mapping and a body, with LF endings. */
export function serializeFrontmatter(data: Readonly<Record<string, unknown>>, body: string): string {
  const header = stringifyYaml(data, { lineWidth: 0 }).trimEnd();
  return `---\n${header}\n---\n\n${body.trimEnd()}\n`;
}

/* -------------------------------------------------------------------------- */
/* The scans                                                                  */
/* -------------------------------------------------------------------------- */

/** A shape a credential takes. Any hit is an error: a memory never holds one. */
export const SECRET_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    label: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'API key literal', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  {
    label: 'credential assignment',
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|credential)s?\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+.]{16,}/i,
  },
];

/** Phrases that read as an instruction to the model rather than a fact for it. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions/i,
  /disregard\s+(?:all\s+|your\s+)?(?:previous|prior|system|safety)/i,
  /new\s+system\s+prompt/i,
  /do\s+not\s+tell\s+the\s+user/i,
  /hide\s+this\s+from\s+the\s+user/i,
  /override\s+(?:all\s+)?safety/i,
];

/**
 * Characters that render as nothing. Zero-width joiners and spaces, the
 * bidirectional controls, a byte-order mark away from the start of the file,
 * and the Unicode tag block — the ranges the documented rules-file attacks use.
 */
export const INVISIBLE_UNICODE = /[​-‍‪-‮⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;

/** A command a memory should describe rather than carry. A warning, not an error. */
export const SHELL_RISK = /(curl[^\n]*\|\s*(?:ba)?sh)|(\brm\s+-rf\b)|(\bsudo\b)/;

/** A date that ages badly. "as soon as" is idiom, not a date. A warning. */
export const RELATIVE_DATES =
  /\b(yesterday|tomorrow|last (?:week|month|year)|next (?:week|month|year)|recently|(?<!as )soon(?! as))\b/i;

export interface ContentScan {
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/** Run every scan over the text a memory carries into context. */
export function scanContent(text: string): ContentScan {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) problems.push(`possible secret (${label}) — memories must never contain credentials`);
  }
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      problems.push('reads as an instruction to the model rather than a fact — rephrase it');
      break;
    }
  }
  if (INVISIBLE_UNICODE.test(text)) {
    problems.push('contains invisible Unicode (zero-width, bidirectional or tag characters) — remove it');
  }
  if (SHELL_RISK.test(text)) warnings.push('carries a risky shell command — describe it rather than quote it');
  if (RELATIVE_DATES.test(text)) warnings.push('uses a relative date — write an absolute one (2026-09-15)');
  return { problems, warnings };
}
