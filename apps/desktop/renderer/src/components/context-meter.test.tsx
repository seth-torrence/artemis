/**
 * @vitest-environment jsdom
 *
 * The status bar's meter on a provider with no plan behind it.
 *
 * A local server has no subscription, no 5-hour window and no weekly cap, so
 * `planUsageReporting` is false and the slot on the bar was a disabled gauge
 * glyph reading "llama.cpp does not report plan usage". True, and useless: the
 * one budget a local run *does* spend is its context window, and that is
 * exactly the question the rings exist to answer.
 *
 * What is worth testing is the state machine rather than the drawing — which of
 * four readings the slot is showing, and whether it can ever show a number that
 * is not true:
 *
 *   1. plan limits           → the rings, unchanged. The regression guard.
 *   2. context, with a window → `Ctx 8.3k / 33k`
 *   3. context, no window     → `Ctx 8.3k`, and no invented denominator
 *   4. neither                → the glyph, with a reason attached
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusLine } from '@/components/StatusLine';
import { ALL_CAPABILITIES, seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  usagePlan: {
    cached: async () => ({ ok: true, value: { usage: null } }),
    refresh: async () => ({ ok: true, value: { usage: null } }),
  },
};

/** A local profile: everything on except the plan gauges. */
const LOCAL_CAPS = {
  ...ALL_CAPABILITIES,
  planUsageReporting: false,
  contextReporting: true,
};

interface SeedOptions {
  readonly capabilities?: Record<string, unknown>;
  readonly usage?: Record<string, unknown> | undefined;
  /** The per-model memory the readout falls back to. */
  readonly contextWindows?: Record<string, number>;
  readonly live?: boolean;
}

function seed(options: SeedOptions = {}): void {
  const capabilities = options.capabilities ?? LOCAL_CAPS;
  seedApp({
    providers: [
      {
        id: 'llamacpp',
        label: 'llama.cpp',
        capabilities,
        models: [],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'llamacpp',
    profiles: [
      { id: 'p1', label: 'Local', providerId: 'llamacpp', configDir: '/home/u/.artemis' },
    ],
    activeProfileId: 'p1',
    cwd: '/code/api',
    workspace: null,
    contextWindows: options.contextWindows ?? {},
    run:
      options.live === false
        ? null
        : {
            runId: 'run-1',
            status: 'running',
            providerId: 'llamacpp',
            profileId: 'p1',
            cwd: '/code/api',
            capabilities,
            startedAt: 1,
            model: 'qwen3.8-27b',
            ...(options.usage === undefined ? {} : { usage: options.usage }),
          },
    sessions: [],
    permissionQueue: [],
    banners: [],
    planUsageByProfile: {},
  } as never);
}

function mount(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <StatusLine />
    </TooltipProvider>,
  );
}

/** The trigger, which is also where the reading is spelled out for a reader. */
function meter(): HTMLElement {
  return screen.getByRole('button', { name: /Context window/ });
}

/** What the trigger paints. `jest-dom` is not installed; this is the substitute. */
function shown(): string {
  return meter().textContent ?? '';
}

/** What it announces. */
function spoken(): string {
  return meter().getAttribute('aria-label') ?? '';
}

/**
 * The explanation behind a disabled glyph.
 *
 * Radix mounts a tooltip only once its trigger is focused, and asserting it
 * this way rather than looking for the text in the initial DOM is the point: it
 * proves the reason is reachable by keyboard, which is what makes an
 * explained-disabled control better than a hidden one.
 */
async function glyphExplanation(): Promise<string> {
  // By the glyph, not by "the first reason-wrapper on the bar" — the model and
  // mode chips carry their own, and this assertion is about this control.
  const wrapper = document.querySelector('.lucide-gauge')?.closest('[data-slot="reason-wrapper"]');
  expect(wrapper).toBeTruthy();
  fireEvent.focus(wrapper as Element);
  const bubbles = await screen.findAllByRole('tooltip');
  return bubbles.map((node) => node.textContent ?? '').join(' ');
}

afterEach(cleanup);

describe('the context-only meter', () => {
  it('mounts on a provider with context but no plan, and shows both numbers', async () => {
    seed({ usage: { scope: 'cumulative', tokens: {}, contextTokens: 8_300, contextWindow: 32_768 } });
    mount();

    expect(shown()).toContain('8.3k / 33k');
    // Named in front of the ring, on the same rule as "5hr" and "Week": a
    // number whose subject you have to infer from position is one you misread.
    expect(shown()).toContain('Ctx');
  });

  it('spells the reading out for a screen reader, window included', async () => {
    // The ring's number is inside a button whose label overrides its children,
    // so a bare "38" with no window attached is all that would be announced.
    seed({ usage: { scope: 'cumulative', tokens: {}, contextTokens: 8_300, contextWindow: 32_768 } });
    mount();

    expect(spoken()).toBe('Context window — 8.3k of 33k');
  });

  it('shows the occupancy with no denominator when nobody stated a window', async () => {
    /*
      The ordinary case behind a router that proxies only `/v1`. There is no
      third fallback by design — a table of model specs held in the client would
      go stale silently and print a confidently wrong "of 128k" under a server
      serving 32k — so the number stands alone.
    */
    seed({ usage: { scope: 'cumulative', tokens: {}, contextTokens: 8_300 } });
    mount();

    expect(shown()).toContain('8.3k');
    expect(shown()).not.toContain('/');
    expect(spoken()).toContain('window size unknown');
  });

  it('falls back to what this model reported on an earlier run', async () => {
    // The window is only restated at run end, so mid-turn the live snapshot has
    // occupancy and no scale. Without the memory the gauge would lose its
    // denominator every time a new turn started.
    seed({
      usage: { scope: 'cumulative', tokens: {}, contextTokens: 8000 },
      contextWindows: { 'qwen3.8-27b': 32_768 },
    });
    mount();

    expect(shown()).toContain('8.0k / 33k');
  });

  it('does not borrow another model’s window', async () => {
    // A confidently wrong denominator is worse than none: the remembered map is
    // keyed by model precisely so a switch does not re-scale the gauge.
    seed({
      usage: { scope: 'cumulative', tokens: {}, contextTokens: 8000 },
      contextWindows: { 'some-other-model': 200_000 },
    });
    mount();

    expect(shown()).toContain('8.0k');
    expect(shown()).not.toContain('200k');
  });

  it('reads zero rather than unknown on a run that has not reported yet', async () => {
    // A started session genuinely holds nothing beyond its prompt, and the
    // window is known from the memory, so 0 is the honest reading.
    seed({ contextWindows: { 'qwen3.8-27b': 32_768 } });
    mount();

    expect(shown()).toContain('0 / 33k');
  });

  it('degrades to the glyph, with a reason, when neither can be reported', async () => {
    /*
      Deliberately not an empty ring: an unfilled ring is indistinguishable from
      a ring at 0%, and "this provider cannot report" must not read as "you have
      used none of it". A different shape is the point.
    */
    seed({
      capabilities: { ...ALL_CAPABILITIES, planUsageReporting: false, contextReporting: false },
      usage: { scope: 'cumulative', tokens: {}, contextTokens: 8_300 },
    });
    mount();

    expect(screen.queryByRole('button', { name: /Context window/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Plan usage/ })).toBeNull();
    expect(await glyphExplanation()).toContain('does not report plan usage or context');
  });

  it('leaves a plan provider on its rings', async () => {
    // The regression guard. A Claude or Artemis Server profile keeps the three
    // plan gauges; nothing about this feature reaches that path.
    seed({
      capabilities: { ...ALL_CAPABILITIES, planUsageReporting: true, contextReporting: true },
      usage: { scope: 'cumulative', tokens: {}, contextTokens: 12_300, contextWindow: 32_768 },
    });
    mount();

    expect(screen.getByRole('button', { name: /Plan usage/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Context window/ })).toBeNull();
  });
});
