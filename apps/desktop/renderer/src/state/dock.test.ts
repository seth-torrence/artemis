/**
 * The dock's ownership and tab rules.
 *
 * These are pure functions over a description of what the columns are showing,
 * which is the whole reason `dock.ts` is shaped the way it is: every rule below
 * is an edge case about conversations moving between columns, and none of them
 * needs a window, a store or a running shell to state.
 *
 * The claims worth pinning, because each fails silently:
 *
 *  - **A terminal follows its conversation**, including into a different column
 *    after a resume. Getting this wrong strands a running shell with no tab.
 *  - **A conversation with no run yet still owns things.** This is the ordinary
 *    case for ⌘J on a fresh session, and an ownership check that assumed a run
 *    id would drop the tab on the frame it was created.
 *  - **Adoption happens once, and only from the right run.** A stale adoption
 *    re-homes a tab onto work it has nothing to do with.
 *  - **Closing a tab activates its left neighbour**, not the first tab and not
 *    nothing.
 *  - **Scope filters what is drawn, never what exists** — the ADR 0002 rule
 *    that makes the focused-conversation default safe to have.
 */

import { describe, expect, it } from 'vitest';

import {
  learnSessionId,
  nextActiveTab,
  ownerIsShown,
  sameTab,
  shownOwning,
  tabKey,
  visibleTabs,
  type BrowserRecord,
  type DockOwner,
  type DockTab,
  type ShownConversation,
  type TerminalRecord,
} from './dock';

/** A terminal record, with only the fields these rules look at. */
function terminal(id: string, owner: DockOwner): TerminalRecord {
  return {
    info: { id, shell: '/bin/zsh', cwd: '/w', startedAt: 0, exited: false },
    owner,
    title: 'zsh',
    exited: false,
  };
}

const term = (id: string): DockTab => ({ kind: 'terminal', id });
const preview = (id: string): DockTab => ({ kind: 'preview', id });

describe('tab identity', () => {
  it('tells a preview apart from a terminal, and terminals from each other', () => {
    expect(sameTab(preview('p1'), { kind: 'preview', id: 'p1' })).toBe(true);
    // Two previews are two tabs now — the window singleton is gone, so the
    // id is the identity, exactly as it is for a file.
    expect(sameTab(preview('p1'), preview('p2'))).toBe(false);
    expect(sameTab(term('a'), term('a'))).toBe(true);
    expect(sameTab(term('a'), term('b'))).toBe(false);
    expect(sameTab(preview('p1'), term('a'))).toBe(false);
    expect(sameTab(null, null)).toBe(true);
    expect(sameTab(null, preview('p1'))).toBe(false);
  });

  it('gives keys that cannot collide across the two kinds', () => {
    expect(tabKey(preview('x'))).not.toBe(tabKey(term('x')));
  });
});

describe('ownerIsShown', () => {
  /*
   * The durable case. A session id outlives the run that produced it, so a
   * conversation resumed into a *different* column still matches — which is what
   * makes a terminal feel like it belongs to the project rather than to a
   * rectangle on screen.
   */
  it('follows a session into whichever column it is showing in', () => {
    const owner: DockOwner = { paneId: 'pane1', runId: 'run1', sessionId: 'sess1' };
    const elsewhere: readonly ShownConversation[] = [
      { paneId: 'pane9', runId: 'run7', sessionId: 'sess1' },
    ];
    expect(ownerIsShown(owner, elsewhere)).toBe(true);
  });

  it('is not shown when its session is nowhere on screen', () => {
    const owner: DockOwner = { paneId: 'pane1', sessionId: 'sess1' };
    expect(ownerIsShown(owner, [{ paneId: 'pane1', sessionId: 'other' }])).toBe(false);
    expect(ownerIsShown(owner, [])).toBe(false);
  });

  /*
   * Before `session.started` there is nothing durable to match on, so identity
   * is the run *in the column it started in*. A pane whose run has been replaced
   * is a different conversation even though it is the same column.
   */
  it('falls back to the run, in the column it started in', () => {
    const owner: DockOwner = { paneId: 'pane1', runId: 'run1' };
    expect(ownerIsShown(owner, [{ paneId: 'pane1', runId: 'run1' }])).toBe(true);
    expect(ownerIsShown(owner, [{ paneId: 'pane1', runId: 'run2' }])).toBe(false);
    expect(ownerIsShown(owner, [{ paneId: 'pane2', runId: 'run1' }])).toBe(false);
  });

  /*
   * The ordinary case for ⌘J on a fresh window: no run and no session, so the
   * pane is the whole identity — and it stays the whole identity as that column
   * is used.
   *
   * The last two assertions are the interesting ones. A conversation starting in
   * that column does *not* orphan the terminal, which is a deliberate departure
   * from how the run-identified case behaves: there was no conversation for the
   * shell to belong to when it was opened, and making it vanish the first time
   * the user pressed Enter would read as a crash.
   */
  it('identifies a conversation that has never run anything by its pane, and keeps it', () => {
    const owner: DockOwner = { paneId: 'pane1' };
    expect(ownerIsShown(owner, [{ paneId: 'pane1' }])).toBe(true);
    expect(ownerIsShown(owner, [{ paneId: 'pane2' }])).toBe(false);
    expect(ownerIsShown(owner, [{ paneId: 'pane1', runId: 'run1' }])).toBe(true);
    expect(ownerIsShown(owner, [{ paneId: 'pane1', sessionId: 'sess1' }])).toBe(true);
  });

  /*
   * The other side of that coin, and the reason `learnSessionId` refuses to
   * adopt without a run: a column-owned terminal must not quietly become some
   * session's terminal, or closing that session would take an unrelated shell
   * with it.
   */
  it('never lets a column-owned tab adopt whichever session turns up', () => {
    expect(learnSessionId({ paneId: 'pane1' }, [{ paneId: 'pane1', sessionId: 'sess1' }])).toBeNull();
  });
});

describe('shownOwning', () => {
  /*
   * `ownerIsShown` with the answer attached: the strip groups tabs under the
   * conversation that owns them, and the group a session-owned surface joins is
   * the one *showing the session*, wherever that is — not the column the
   * surface happened to be opened in.
   */
  it('names the conversation showing the owner, not the column it was opened in', () => {
    const owner: DockOwner = { paneId: 'pane1', sessionId: 'sess1' };
    const shown: readonly ShownConversation[] = [
      { paneId: 'pane1', sessionId: 'other' },
      { paneId: 'pane2', sessionId: 'sess1' },
    ];
    expect(shownOwning(owner, shown)?.paneId).toBe('pane2');
  });

  it('agrees with ownerIsShown about absence', () => {
    expect(shownOwning({ paneId: 'pane1', sessionId: 's' }, [{ paneId: 'pane1' }])).toBeUndefined();
    expect(shownOwning({ paneId: 'gone' }, [{ paneId: 'pane1' }])).toBeUndefined();
  });
});

describe('visibleTabs', () => {
  const here: readonly ShownConversation[] = [{ paneId: 'pane1' }];
  const away: readonly ShownConversation[] = [{ paneId: 'pane2' }];

  it('puts the preview first and terminals in the order they were opened', () => {
    const tabs = visibleTabs(
      [{ id: 'p1', owner: { paneId: 'pane1' } }],
      [terminal('t1', { paneId: 'pane1' }), terminal('t2', { paneId: 'pane1' })],
      here,
    );
    expect(tabs.map(tabKey)).toEqual(['preview:p1', 'terminal:t1', 'terminal:t2']);
  });

  it('hides everything belonging to a conversation that has left', () => {
    const tabs = visibleTabs(
      [{ id: 'p1', owner: { paneId: 'pane1' } }],
      [terminal('t1', { paneId: 'pane1' })],
      away,
    );
    expect(tabs).toEqual([]);
  });

  /*
   * The split-view case: two conversations side by side, each with a shell. A
   * pane must never show the other pane's terminal.
   */
  it('shows only the tabs of conversations that are on screen', () => {
    const tabs = visibleTabs(
      [],
      [terminal('mine', { paneId: 'pane1' }), terminal('theirs', { paneId: 'pane2' })],
      here,
    );
    expect(tabs.map(tabKey)).toEqual(['terminal:mine']);
  });

  /*
   * Conversation-major grouping — ADR 0002's answer to four identical icons in
   * a 2×2. Each visible conversation's surfaces sit together, in grid order,
   * rather than every conversation's terminals pooling by kind.
   */
  it('groups a split window’s tabs by conversation, in grid order', () => {
    const both: readonly ShownConversation[] = [{ paneId: 'pane1' }, { paneId: 'pane2' }];
    const tabs = visibleTabs(
      [{ id: 'p2', owner: { paneId: 'pane2' } }],
      [terminal('t1', { paneId: 'pane1' }), terminal('t2', { paneId: 'pane2' })],
      both,
      [],
      [{ id: 'f1', owner: { paneId: 'pane1' } }],
    );
    expect(tabs.map(tabKey)).toEqual([
      // Everything pane1's conversation owns…
      'file:f1',
      'terminal:t1',
      // …then everything pane2's does.
      'preview:p2',
      'terminal:t2',
    ]);
  });

  /*
   * A session-owned surface joins the group of the conversation showing it —
   * whichever column that is. The alternative files the tab under a column
   * that is showing something else entirely.
   */
  it('files a session-owned tab under the pane showing its session', () => {
    const both: readonly ShownConversation[] = [
      { paneId: 'pane1' },
      { paneId: 'pane2', sessionId: 'sess1' },
    ];
    const tabs = visibleTabs(
      [],
      [
        terminal('mine', { paneId: 'pane1' }),
        // Opened in pane1 once, but its session now shows in pane2.
        terminal('moved', { paneId: 'pane1', sessionId: 'sess1' }),
      ],
      both,
    );
    expect(tabs.map(tabKey)).toEqual(['terminal:mine', 'terminal:moved']);
  });
});

/*
 * The scope: the strip drawn for one conversation. This is the dock's 2.0
 * default — surfaces belong to conversations, and the strip follows the
 * focused one — with `null` as the explicit everything view. What it must
 * never do is *destroy*: the same records with the other scope still produce
 * every tab, which is the drawn-versus-exists line the whole dock stands on.
 */
describe('visibleTabs scoped to one pane', () => {
  const both: readonly ShownConversation[] = [{ paneId: 'pane1' }, { paneId: 'pane2' }];
  const terminals = [terminal('t1', { paneId: 'pane1' }), terminal('t2', { paneId: 'pane2' })];

  it('draws only the focused conversation’s tabs', () => {
    const tabs = visibleTabs([], terminals, both, [], [], [], true, 'pane1');
    expect(tabs.map(tabKey)).toEqual(['terminal:t1']);
  });

  it('draws everything again the moment the scope widens', () => {
    // Same records, same conversations — only the scope changed. Nothing was
    // destroyed by being out of scope.
    const tabs = visibleTabs([], terminals, both, [], [], [], true, null);
    expect(tabs.map(tabKey)).toEqual(['terminal:t1', 'terminal:t2']);
  });

  it('follows a conversation’s surfaces into the focused pane, wherever they were opened', () => {
    const showing: readonly ShownConversation[] = [
      { paneId: 'pane1', sessionId: 'sess1' },
      { paneId: 'pane2' },
    ];
    // Opened in pane2 back when it showed sess1; pane1 shows sess1 now.
    const moved = [terminal('t9', { paneId: 'pane2', sessionId: 'sess1' })];
    expect(visibleTabs([], moved, showing, [], [], [], true, 'pane1').map(tabKey)).toEqual([
      'terminal:t9',
    ]);
    expect(visibleTabs([], moved, showing, [], [], [], true, 'pane2')).toEqual([]);
  });

  it('scopes the per-pane tabs — files, tasks, agents — the same way', () => {
    const busy: readonly ShownConversation[] = [
      { paneId: 'pane1', hasTasks: true, filesRequested: true },
      { paneId: 'pane2', hasTasks: true },
    ];
    const tabs = visibleTabs([], [], busy, [{ paneId: 'pane2', taskId: 'task1' }], [], [], true, 'pane2');
    expect(tabs.map(tabKey)).toEqual(['tasks:pane2', 'agent:pane2:task1']);
  });

  it('draws the documents list beside the folder browser, and only when asked', () => {
    const asked: readonly ShownConversation[] = [
      { paneId: 'pane1', filesRequested: true, documentsRequested: true },
      { paneId: 'pane2', documentsRequested: true },
    ];
    expect(visibleTabs([], [], asked, [], [], [], true, 'pane1').map(tabKey)).toEqual([
      'files:pane1',
      'documents:pane1',
    ]);
    expect(visibleTabs([], [], asked, [], [], [], true, 'pane2').map(tabKey)).toEqual([
      'documents:pane2',
    ]);
    // A request, never an arrival: the setting that keeps agent surfaces out
    // of the strip has no say over it.
    expect(visibleTabs([], [], asked, [], [], [], false, 'pane2').map(tabKey)).toEqual([
      'documents:pane2',
    ]);
    expect(visibleTabs([], [], [{ paneId: 'pane1' }], [], [], [], true, 'pane1')).toEqual([]);
    // Two views of one column are two tabs.
    expect(
      sameTab({ kind: 'documents', paneId: 'pane1' }, { kind: 'files', paneId: 'pane1' }),
    ).toBe(false);
  });
});

/*
 * Previews, plural: one per conversation, none for the window. The singleton
 * behaviour — previewing in pane B replacing pane A's — is the bug ADR 0002
 * names, so the rule gets its own describe.
 */
describe('two previews side by side', () => {
  it('draws each conversation’s preview, in its group', () => {
    const both: readonly ShownConversation[] = [{ paneId: 'pane1' }, { paneId: 'pane2' }];
    const tabs = visibleTabs(
      [
        { id: 'p1', owner: { paneId: 'pane1' } },
        { id: 'p2', owner: { paneId: 'pane2' } },
      ],
      [],
      both,
    );
    expect(tabs.map(tabKey)).toEqual(['preview:p1', 'preview:p2']);
  });

  it('drops only the preview whose conversation left', () => {
    const tabs = visibleTabs(
      [
        { id: 'p1', owner: { paneId: 'pane1' } },
        { id: 'p2', owner: { paneId: 'gone' } },
      ],
      [],
      [{ paneId: 'pane1' }],
    );
    expect(tabs.map(tabKey)).toEqual(['preview:p1']);
  });
});

/*
 * The "open on its own" appearance option, at the layer where it bites: a tab
 * in an empty strip is what opens the dock, so keeping agent arrivals out of
 * `visibleTabs` is the entire mechanism. What must never be caught in it is
 * anything the user opened themselves — that is the difference between an
 * option that quiets the window and one that loses people's shells.
 */
describe('visibleTabs with the dock forbidden to open on its own', () => {
  const here: readonly ShownConversation[] = [{ paneId: 'pane1' }];
  const busy: readonly ShownConversation[] = [{ paneId: 'pane1', hasTasks: true }];

  function browser(id: string, agentOpened: boolean): BrowserRecord {
    return {
      info: {
        id,
        openedAt: 0,
        state: { url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false },
      },
      owner: { paneId: 'pane1' },
      ...(agentOpened ? { agentOpened: true } : {}),
    } as BrowserRecord;
  }

  it('keeps the tasks tab out of the strip', () => {
    expect(visibleTabs([], [], busy, [], [], [], false)).toEqual([]);
    // And the flag defaulting to true is every release before it: same state,
    // tab present.
    expect(visibleTabs([], [], busy).map(tabKey)).toEqual(['tasks:pane1']);
  });

  it('lets the tasks tab in when the user asked for it', () => {
    const asked: readonly ShownConversation[] = [
      { paneId: 'pane1', hasTasks: true, tasksRequested: true },
    ];
    // The delegated tab is the one surface here with two origins, and only the
    // uninvited one is what this setting is about. Suppressing the press too
    // leaves the header's Delegated button enabled and inert.
    expect(visibleTabs([], [], asked, [], [], [], false).map(tabKey)).toEqual(['tasks:pane1']);
  });

  it('will not let it in on the flag alone', () => {
    // `hasTasks` still decides whether a tab is warranted at all — a column
    // whose rows were dismissed answers no, and a stale request must not
    // resurrect it. The two are read in that order, never as alternatives.
    const stale: readonly ShownConversation[] = [{ paneId: 'pane1', tasksRequested: true }];
    expect(visibleTabs([], [], stale, [], [], [], false)).toEqual([]);
    expect(visibleTabs([], [], stale, [], [], [], true)).toEqual([]);
  });

  it('keeps an agent-opened page out, and leaves the user’s own alone', () => {
    const tabs = visibleTabs(
      [],
      [],
      here,
      [],
      [],
      [browser('mine', false), browser('theirs', true)],
      false,
    );
    expect(tabs.map(tabKey)).toEqual(['browser:mine']);
  });

  it('reveals what arrived while it was off, the moment it is back on', () => {
    const records = [browser('hidden', true)];
    expect(visibleTabs([], [], busy, [], [], records, false)).toEqual([]);
    // Same records, same conversations — only the permission changed. This is
    // `setDockAutoOpen`'s reveal: nothing was destroyed by being suppressed.
    expect(visibleTabs([], [], busy, [], [], records, true).map(tabKey)).toEqual([
      'browser:hidden',
      'tasks:pane1',
    ]);
  });

  it('touches nothing the user opened: preview, file, shells, agent tabs', () => {
    const tabs = visibleTabs(
      [{ id: 'p1', owner: { paneId: 'pane1' } }],
      [terminal('t1', { paneId: 'pane1' })],
      here,
      [{ paneId: 'pane1', taskId: 'task9' }],
      [{ id: 'f1', owner: { paneId: 'pane1' } }],
      [],
      false,
    );
    expect(tabs.map(tabKey)).toEqual(['preview:p1', 'file:f1', 'terminal:t1', 'agent:pane1:task9']);
  });
});

describe('nextActiveTab', () => {
  const strip = [preview('p1'), term('a'), term('b'), term('c')];

  it('leaves a still-visible tab alone', () => {
    expect(nextActiveTab(term('b'), strip, strip)).toEqual(term('b'));
  });

  /*
   * Chrome's rule, and `closePane`'s: the eye is already where the closed tab
   * was, so the neighbour to its left is the least disorienting place to land.
   */
  it('falls to the neighbour on the left when its tab goes', () => {
    const after = [preview('p1'), term('a'), term('c')];
    expect(nextActiveTab(term('b'), after, strip)).toEqual(term('a'));
  });

  it('keeps walking left past tabs that also went', () => {
    const after = [preview('p1'), term('c')];
    expect(nextActiveTab(term('b'), after, strip)).toEqual(preview('p1'));
  });

  it('takes the first tab when the one that went was leftmost', () => {
    const after = [term('a'), term('b'), term('c')];
    expect(nextActiveTab(preview('p1'), after, strip)).toEqual(term('a'));
  });

  it('is null when the strip is empty, and adopts a tab when it was', () => {
    expect(nextActiveTab(term('a'), [], strip)).toBeNull();
    expect(nextActiveTab(null, [preview('p1')], [])).toEqual(preview('p1'));
  });
});
