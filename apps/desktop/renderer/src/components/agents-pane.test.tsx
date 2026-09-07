/**
 * @vitest-environment jsdom
 *
 * The prompt library (the rule half of the Instructions pane): what a person
 * sees, and what they are prevented from claiming.
 *
 * Composition is settled in `protocol/agentPrompts.test.ts` and storage in
 * `main/agentPrompts.test.ts`. What is left here is the pane's own judgements,
 * and three of them are worth a test because getting any one wrong produces a
 * prompt the user believes is being sent and is not:
 *
 *  1. **A profile whose provider cannot take an appended system prompt is
 *     shown, disabled, with the reason.** The failure this prevents is the
 *     quiet one — a Codex profile ticked in a settings pane while the model is
 *     never told a word of it. Hiding the row would be the same lie with better
 *     manners.
 *  2. **A built-in can be deleted, and the deletion sticks; only the one about
 *     the user's team can be edited.** A deleted built-in used to come back on
 *     the next read and read as the app overruling the user, which is why the
 *     pane offered no delete. Now the removal is recorded and offered back
 *     under the list. Editing is narrower: the memory-bank prompt is mostly
 *     claims about a team Artemis cannot know, so that one is the user's to
 *     take over — and taking it over has to be recorded, and reversible, or
 *     Artemis silently stops updating a prompt nobody decided to freeze.
 *  3. **"Every profile" is not the same as ticking every box.** Unticking it
 *     has to produce a concrete list, and that list has to exclude the profiles
 *     that could not have received it anyway.
 *
 * The bridge is stubbed rather than left to the dev mock, for the reason the
 * shared-config suite gives: the mock reports a populated library, which is
 * right for developing the pane and wrong for a test that needs to control what
 * is on screen.
 *
 * Same caveat as the sibling component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { BUILT_IN_AGENT_PROMPTS, NO_CAPABILITIES } from '@rx-artemis/protocol';
import { TooltipProvider } from '@/components/ui/tooltip';
import { InstructionsSection } from '@/components/settings/InstructionsSection';
import { seedApp } from '@/state/testkit';

/* -------------------------------------------------------------------------- */
/* The world the pane is rendered into                                        */
/* -------------------------------------------------------------------------- */

const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    capabilities: { ...NO_CAPABILITIES, systemPromptAppend: true },
  },
  {
    // The provider that cannot take one. This is the whole reason the pane has
    // a disabled state at all.
    id: 'codex',
    label: 'Codex',
    capabilities: { ...NO_CAPABILITIES, systemPromptAppend: false },
  },
];

const PROFILES = [
  { id: 'work', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' },
  { id: 'side', label: 'Side', providerId: 'codex', configDir: '/home/u/.side' },
];

const HOUSE_STYLE = {
  id: 'p1',
  name: 'House style',
  markdown: 'Run the typechecker.',
  enabled: true,
  scope: { kind: 'all' as const },
};

const MEMORY_BANKS_PROMPT_NAME = BUILT_IN_AGENT_PROMPTS['builtin:cerebro'].name;

const CEREBRO_ROW = {
  id: 'builtin:cerebro',
  name: MEMORY_BANKS_PROMPT_NAME,
  markdown: '',
  enabled: true,
  scope: { kind: 'all' as const },
  builtIn: 'builtin:cerebro' as const,
};

/**
 * A second built-in, invented here and registered in the map the pane reads.
 *
 * The rule under test is that editing was granted to one prompt rather than to
 * built-ins as a class, and Artemis ships exactly one built-in today — so
 * without a second one the test would be pinning a coincidence. Removed again
 * after this file's tests, since the map is a module-level export.
 */
const OTHER_BUILT_IN = 'builtin:test-only';
(BUILT_IN_AGENT_PROMPTS as unknown as Record<string, unknown>)[OTHER_BUILT_IN] = {
  id: OTHER_BUILT_IN,
  name: 'Something else Artemis ships',
  summary: 'A built-in about Artemis, not about the team.',
  requires: 'nothing this machine is missing',
  markdown: 'Artemis wrote this one and keeps it.',
};

const OTHER_BUILT_IN_ROW = {
  id: OTHER_BUILT_IN,
  name: 'Something else Artemis ships',
  markdown: '',
  enabled: true,
  scope: { kind: 'all' as const },
  builtIn: OTHER_BUILT_IN,
};

/** The library the next `list` answers with. Reassigned per test before rendering. */
let library: unknown[] = [];
/** Built-ins the stubbed library records as removed. */
let dismissed: string[] = [];
/**
 * Whether the stubbed banks report themselves usable — master gate on, and a
 * bank that exists and is wired. The same conjunction `banksAvailability`
 * reads, because it is the one that decides whether the built-in row claims to
 * be reaching the model.
 */
let banksAvailable = true;
/** Every document the pane has saved, oldest first. */
let saved: { prompts: unknown[]; dismissedBuiltIns?: unknown }[] = [];

/*
 * Installed once, before the first render: `resolveBridge` memoises its binding
 * on first use, so a stub swapped in later would never be seen. Behaviour is
 * varied through the variables above instead.
 *
 * The banks channel answers with the smallest status that decides the one
 * thing this file cares about — whether the built-in memory-banks prompt is
 * actually being sent. The pane derives that from the same reading its banks
 * half renders from (`banksAvailability`), so the stub is the shared source of
 * both.
 */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  agentPrompts: {
    list: async () => ({
      ok: true as const,
      value: {
        document: {
          version: 1,
          prompts: library,
          ...(dismissed.length === 0 ? {} : { dismissedBuiltIns: dismissed }),
        },
      },
    }),
    save: async (request: { document: { prompts: unknown[]; dismissedBuiltIns?: unknown } }) => {
      saved.push(request.document);
      return { ok: true as const, value: { document: request.document } };
    },
  },
  memoryBanks: {
    status: async () => ({
      ok: true as const,
      value: {
        cliAvailable: true,
        masterEnabled: banksAvailable,
        banks: [
          {
            slug: 'team',
            path: '/x/team',
            remote: null,
            role: 'readwrite',
            enabled: banksAvailable,
            isDefault: true,
            exists: banksAvailable,
            source: null,
            memories: 0,
            validationErrors: 0,
            projects: 0,
          },
        ],
        profiles: [],
      },
    }),
    preflight: async () => ({ ok: true as const, value: { ready: true, checks: [] } }),
  },
};

afterAll(() => {
  delete (BUILT_IN_AGENT_PROMPTS as unknown as Record<string, unknown>)[OTHER_BUILT_IN];
});

function renderPane(): void {
  render(
    <TooltipProvider>
      <InstructionsSection />
    </TooltipProvider>,
  );
}

/** Render, and wait for the library to have landed. */
async function renderLoaded(): Promise<void> {
  renderPane();
  await waitFor(() => expect(screen.queryByText('Reading the library…')).toBeNull());
}

/**
 * Let the save debounce elapse, without spending it.
 *
 * `useAgentPrompts` saves on a 600ms debounce, and this file used to wait it
 * out five times on the wall clock — three seconds in isolation, and far worse
 * inside the full suite, where the run competes for CPU and a real timer that
 * asks for 600ms gets whatever it gets. That is what made this file the
 * slowest in the suite and the one that looked flaky: it was not racing, it was
 * queueing.
 *
 * Fake timers make it exact instead. `advanceTimersByTimeAsync` also flushes
 * the microtasks the save promise resolves through, which `advanceTimersByTime`
 * would not.
 */
async function flushSave(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
  });
}

/** Must match `useAgentPrompts`. A test that waits less than the real debounce
 *  would pass by accident today and fail the day the value changes. */
const SAVE_DEBOUNCE_MS = 600;

/** The most recent saved document, or null. */
function lastSave(): { prompts: any[] } | null {
  return (saved.at(-1) as { prompts: any[] } | undefined) ?? null;
}

/**
 * Open one prompt in the editor.
 *
 * Anchored with `^` because the *selected* prompt also contributes a
 * `Delete “<name>”` button, and an unanchored name would match both. The row's
 * own accessible name is its title followed by the line describing its scope.
 */
function open(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
}

/** Turn "every profile" off, revealing the per-profile list. */
function narrow(): void {
  fireEvent.click(screen.getByText('Every profile'));
}

beforeEach(() => {
  // `shouldAdvanceTime` keeps the library's initial read — a real promise, not
  // a timer — from hanging while the clock is frozen. Without it `renderLoaded`
  // waits forever for "Reading the library…" to disappear.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seedApp({ providers: PROVIDERS as never, profiles: PROFILES as never });
  library = [HOUSE_STYLE, CEREBRO_ROW];
  dismissed = [];
  banksAvailable = true;
  saved = [];
  // TipTap drives a contenteditable through ProseMirror, which reaches for
  // layout APIs jsdom does not implement. Stubbed rather than skipped: the
  // assertions below are about the pane's controls, and an editor that throws
  // on mount would take the whole pane down before any of them could run.
  Object.defineProperty(globalThis.Range.prototype, 'getBoundingClientRect', {
    value: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }),
    configurable: true,
  });
  Object.defineProperty(globalThis.Range.prototype, 'getClientRects', {
    value: () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }),
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

describe('who a prompt reaches', () => {
  it('shows a profile whose provider cannot take an appended prompt, disabled', async () => {
    await renderLoaded();
    open('House style');
    narrow();

    const boxes = screen.getAllByRole('checkbox');
    const labels = boxes.map((box) => box.closest('label')?.textContent ?? '');

    const side = boxes[labels.findIndex((text) => text.includes('Side'))];
    const work = boxes[labels.findIndex((text) => text.includes('Work'))];

    expect(side).toBeTruthy();
    // Present, so the account does not silently vanish from a list the user is
    // using to decide where a prompt goes — and unusable, because it is.
    expect(side!.getAttribute('disabled')).not.toBeNull();
    expect(work!.getAttribute('disabled')).toBeNull();
  });

  it('narrows to the profiles that can actually receive it, not to none', async () => {
    await renderLoaded();
    open('House style');
    narrow();

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const scope = lastSave()!.prompts[0].scope;
    // Not `[]` — that would turn the prompt off as a side effect of the user
    // asking to narrow it. Not `['work','side']` either: `side` could never
    // have received it.
    expect(scope).toEqual({ kind: 'profiles', profileIds: ['work'] });
  });

  it('says plainly when a prompt is scoped to nothing', async () => {
    library = [{ ...HOUSE_STYLE, scope: { kind: 'profiles', profileIds: [] } }, CEREBRO_ROW];
    await renderLoaded();
    expect(screen.getByText(/no profiles — it will not be sent/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Built-ins                                                                  */
/* -------------------------------------------------------------------------- */

describe("Artemis's own prompts", () => {
  it('shows the text it will actually send', async () => {
    await renderLoaded();
    open(MEMORY_BANKS_PROMPT_NAME);

    const surface = document.querySelector('.ProseMirror');
    expect(surface).toBeTruthy();
    // Shown rather than paraphrased: "what exactly will be sent" is the reason
    // someone opens a built-in, and a description of it would be Artemis
    // talking about its own prompt instead of handing it over.
    expect(surface!.textContent).toContain('Team memory bank');
  });

  it('keeps a built-in that is not about the team read-only', async () => {
    library = [HOUSE_STYLE, OTHER_BUILT_IN_ROW];
    await renderLoaded();
    open('Something else Artemis ships');

    // The general rule, still in force: Artemis wrote it, Artemis keeps it
    // current, and an editable copy would drift from the one actually sent.
    const surface = document.querySelector('.ProseMirror');
    expect(surface!.getAttribute('contenteditable')).toBe('false');
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
  });

  it('lets the team memory-bank prompt be edited, starting from Artemis’s words', async () => {
    await renderLoaded();
    open(MEMORY_BANKS_PROMPT_NAME);

    const surface = document.querySelector('.ProseMirror');
    // Editable *and* seeded, which is the pair that matters: an empty box
    // would make taking the prompt over mean rewriting it from memory.
    expect(surface!.getAttribute('contenteditable')).toBe('true');
    expect(surface!.textContent).toContain('Team memory bank');
    // Nothing to reset yet — Artemis's text is still Artemis's.
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
  });

  it('records the takeover on the first edit, so Artemis stops overwriting it', async () => {
    await renderLoaded();
    open(MEMORY_BANKS_PROMPT_NAME);

    // A real gesture through the real editor. The flag has to be set by the
    // *edit*, not by a separate "take this over" control the user would have
    // to find first.
    fireEvent.click(screen.getByRole('button', { name: 'Quote' }));

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const row = lastSave()!.prompts.find((p: any) => p.builtIn === 'builtin:cerebro');
    expect(row.overridden).toBe(true);
    expect(row.markdown.length).toBeGreaterThan(0);
  });

  it('offers reset once the prompt is the user’s, and hands Artemis’s back', async () => {
    library = [HOUSE_STYLE, { ...CEREBRO_ROW, overridden: true, markdown: 'Our bank, our rules.' }];
    await renderLoaded();
    open(MEMORY_BANKS_PROMPT_NAME);

    expect(document.querySelector('.ProseMirror')!.textContent).toContain('Our bank, our rules.');
    fireEvent.click(screen.getByRole('button', { name: /^Reset/ }));

    // On screen as well as in the record: the editor reads its value once, so
    // clearing the row without remounting would leave the user's text sitting
    // in a prompt that no longer contains it.
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')!.textContent).toContain('Team memory bank'),
    );
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();

    await flushSave();
    const row = lastSave()!.prompts.find((p: any) => p.builtIn === 'builtin:cerebro');
    expect(row.overridden).toBe(false);
    expect(row.markdown).toBe('');
  });

  it('can be deleted, and the deletion is recorded so a read does not put it back', async () => {
    await renderLoaded();
    open(MEMORY_BANKS_PROMPT_NAME);
    fireEvent.click(screen.getByRole('button', { name: `Delete “${MEMORY_BANKS_PROMPT_NAME}”` }));
    // The dialog says what removal costs and that it can be brought back.
    expect(screen.getByText(/Bring back/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // Gone from the list.
    expect(screen.queryByRole('button', { name: new RegExp(`^${MEMORY_BANKS_PROMPT_NAME}`) })).toBeNull();

    await flushSave();
    expect(lastSave()).not.toBeNull();
    expect(lastSave()!.prompts.some((p: any) => p.builtIn === 'builtin:cerebro')).toBe(false);
    // The record is the whole point: a row filtered out without it would be
    // re-appended by the next read.
    expect((lastSave() as any).dismissedBuiltIns).toEqual(['builtin:cerebro']);
  });

  it('offers a removed built-in back, in its shipped state', async () => {
    library = [HOUSE_STYLE];
    dismissed = ['builtin:cerebro'];
    await renderLoaded();
    expect(screen.queryByRole('button', { name: new RegExp(`^${MEMORY_BANKS_PROMPT_NAME}`) })).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`^Bring back “${MEMORY_BANKS_PROMPT_NAME}”`) }),
    );
    expect(screen.getByRole('button', { name: new RegExp(`^${MEMORY_BANKS_PROMPT_NAME}`) })).toBeTruthy();

    await flushSave();
    const row = lastSave()!.prompts.find((p: any) => p.builtIn === 'builtin:cerebro');
    expect(row).toBeDefined();
    expect(row.enabled).toBe(true);
    expect(row.overridden).toBeUndefined();
    expect((lastSave() as any).dismissedBuiltIns).toBeUndefined();
  });

  it('still offers delete on a prompt the user wrote', async () => {
    await renderLoaded();
    open('House style');
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeNull();
  });

  it('can still be turned off, which is the durable way to refuse it', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch', { name: new RegExp(MEMORY_BANKS_PROMPT_NAME) }));

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const row = lastSave()!.prompts.find((p: any) => p.builtIn === 'builtin:cerebro');
    expect(row.enabled).toBe(false);
  });

  it('reports an enabled built-in that its precondition has switched off', async () => {
    // The state a plain on/off flag cannot express: the switch says yes, the
    // machine says no bank is wired, and nothing is being sent. The stub has to
    // actually answer "unavailable" for this to test anything — it once
    // answered on a bridge namespace that no longer exists, which made every
    // built-in unavailable and this assertion true for the wrong reason.
    banksAvailable = false;
    await renderLoaded();
    await waitFor(() =>
      expect(screen.getByText(/On, but not sent/)).toBeTruthy(),
    );
  });

  it('says a built-in is being sent when its precondition holds', async () => {
    // The other half, and the one that fails if the availability stub is wired
    // to nothing: both rows have to reach the "sent" line, not just the user's.
    await renderLoaded();
    await waitFor(() => expect(screen.getAllByText(/Sent to every profile/)).toHaveLength(2));
  });
});

/* -------------------------------------------------------------------------- */
/* Editing                                                                    */
/* -------------------------------------------------------------------------- */

describe('the library', () => {
  it('adds a prompt that reaches every profile until it is narrowed', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /New prompt/ }));

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const added = lastSave()!.prompts.at(-1);
    expect(added.scope).toEqual({ kind: 'all' });
    expect(added.enabled).toBe(true);
  });

  it('keeps a turned-off prompt rather than dropping it', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch', { name: /House style/ }));

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const row = lastSave()!.prompts.find((p: any) => p.id === 'p1');
    // Off, and its text intact — "try without it" must not be an expensive
    // experiment.
    expect(row.enabled).toBe(false);
    expect(row.markdown).toBe('Run the typechecker.');
  });

  it('does not offer an editable library when the read failed', async () => {
    // Showing the defaults over a failed read would invite an edit whose first
    // save replaces whatever is really on disk.
    const artemis = (globalThis.window as unknown as { artemis: any }).artemis;
    const original = artemis.agentPrompts.list;
    artemis.agentPrompts.list = async () => ({
      ok: false as const,
      error: { code: 'unknown', message: 'could not read the library' },
    });

    await renderLoaded();
    expect(screen.getByText('could not read the library')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New prompt/ })).toBeNull();

    artemis.agentPrompts.list = original;
  });
});
