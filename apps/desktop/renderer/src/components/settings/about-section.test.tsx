/**
 * @vitest-environment jsdom
 *
 * The About pane, and the property it exists to protect: **it does not claim
 * something went wrong when nothing was attempted.**
 *
 * The pane's reason for being is that the running version and the update check
 * were previously unreachable from anywhere in the window — the version only via
 * the bug-report dialog, the check only via a macOS menu that does not exist on
 * Windows. So the first test here is simply that the version is on screen.
 *
 * The rest is the wording, which is the substance of the pane. `unsupported` is
 * not a failure: on Linux the updater makes no network request at all, because
 * Artemis installs there through a package manager and there is nothing for a
 * check to act on. A pane that reported that as "could not check for updates"
 * would send a Linux user to inspect a proxy for a request that never left.
 * `unreachable` is the outcome that really is the network, and only it gets that
 * wording. The tests below pin the two apart in both directions, because a copy
 * edit that blurred them would be invisible to every other check in the repo.
 *
 * The platform split is load-bearing and it moved: macOS and Windows both
 * update themselves now, so `unsupported` on either can only mean a development
 * build, and only Linux earns the standing platform notice. Getting that
 * backwards would tell every Windows user that the feature they have does not
 * exist.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UpdateCheckOutcome, UpdateState } from '@rx-artemis/protocol';

import { AboutSection } from '@/components/settings/AboutSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useApp } from '@/state/store';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ok = <T,>(value: T) => ({ ok: true as const, value });

const IDLE: UpdateState = {
  phase: 'idle',
  version: null,
  message: null,
  releaseUrl: null,
  progress: null,
};

let outcome: UpdateCheckOutcome = 'current';
let state: UpdateState = IDLE;
const checkCalls: unknown[] = [];
const installCalls: unknown[] = [];

/** Installed before the first render: `resolveBridge` memoises on first use. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  version: '1.4.2',
  platform: 'win32',
  arch: 'x64',
  updates: {
    state: async () => ok({ state }),
    check: async (request: unknown) => {
      checkCalls.push(request);
      return ok({ outcome, state });
    },
    install: async (request: unknown) => {
      installCalls.push(request);
      return ok({ state });
    },
    restart: async () => ok({ state }),
    dismiss: async () => ok({ state }),
    setChannel: async () => ok({ state }),
    onChange: () => () => undefined,
  },
};

async function renderPane(): Promise<void> {
  render(
    <TooltipProvider>
      <AboutSection />
    </TooltipProvider>,
  );
  await act(async () => {});
}

/** Click Check for updates and let its promise settle. */
async function clickCheck(): Promise<void> {
  await act(async () => {
    screen.getByRole('button', { name: 'Check for updates' }).click();
  });
  await act(async () => {});
}

beforeEach(() => {
  outcome = 'current';
  state = IDLE;
  // The pane reads these from the store, which `bootstrap` normally fills from
  // the bridge. Nothing boots in a unit test, so they are set directly.
  useApp.setState({ version: '1.4.2', platform: 'win32', arch: 'x64', updateChannel: 'stable' });
});

afterEach(() => {
  cleanup();
  checkCalls.length = 0;
  installCalls.length = 0;
});

describe('AboutSection', () => {
  it('shows the running version, which was on no screen before this pane', async () => {
    await renderPane();
    expect(screen.getByText('Artemis 1.4.2')).toBeTruthy();
  });

  it('names the platform and architecture, because releases are per-architecture', async () => {
    await renderPane();
    expect(screen.getByText(/Windows · x64/)).toBeTruthy();
  });

  it('says nothing about an architecture that is on no download', async () => {
    // `other` is every architecture Artemis does not publish for. Printing
    // `ia32` beside a link offering arm64 and x64 answers "which do I take?"
    // with a name that is on neither.
    useApp.setState({ arch: 'other' });
    await renderPane();
    expect(screen.getByText('Windows')).toBeTruthy();
    expect(screen.queryByText(/Windows ·/)).toBeNull();
  });

  it('offers the releases page standing, not only after a failure', async () => {
    await renderPane();
    const link = screen.getByRole('link', { name: /Releases page/ });
    expect(link.getAttribute('href')).toBe('https://github.com/seth-torrence/artemis/releases');
  });

  it('says nothing about the outcome of a check nobody has asked for', async () => {
    await renderPane();
    expect(screen.queryByText(/up to date/i)).toBeNull();
    expect(checkCalls).toEqual([]);
  });

  it('reports up to date, naming the version', async () => {
    outcome = 'current';
    await renderPane();
    await clickCheck();

    expect(checkCalls).toHaveLength(1);
    expect(screen.getByText('Artemis is up to date.')).toBeTruthy();
    expect(screen.getByText(/You are running 1\.4\.2/)).toBeTruthy();
  });

  it('reports an available update by name, with the action that installs it', async () => {
    outcome = 'offered';
    state = { ...IDLE, phase: 'available', version: '1.5.0' };
    await renderPane();
    await clickCheck();

    expect(screen.getByText('Artemis 1.5.0 is available.')).toBeTruthy();

    await act(async () => {
      screen.getByRole('button', { name: 'Download and install' }).click();
    });
    expect(installCalls).toHaveLength(1);
  });

  it('blames the network only when a request was actually made', async () => {
    outcome = 'unreachable';
    await renderPane();
    await clickCheck();

    expect(screen.getByText('The update feed could not be reached.')).toBeTruthy();
    expect(screen.getByText(/network is in the way/)).toBeTruthy();
    // The manual route is still on screen — it is the whole point of saying this.
    expect(screen.getByRole('link', { name: /Releases page/ })).toBeTruthy();
  });

  /*
   * The two outcomes that must never be confused, asserted from both sides.
   *
   * `unsupported` on Linux — a .deb or an AppImage, since a pacman install
   * updates itself — means no request was made, so the pane must not
   * borrow the unreachable wording; and `unreachable` means one was, so it must
   * not borrow the "not available on this platform" wording. Either slip
   * produces a user debugging the wrong thing.
   */
  it('does not dress an unsupported platform up as a failed check', async () => {
    outcome = 'unsupported';
    useApp.setState({ platform: 'linux' });
    await renderPane();
    await clickCheck();

    expect(screen.getByText('This install of Artemis cannot update itself.')).toBeTruthy();
    expect(screen.getByText(/No check was made/)).toBeTruthy();
    expect(screen.queryByText(/could not be reached/)).toBeNull();
    expect(screen.queryByText(/network is in the way/)).toBeNull();
  });

  it('warns before the click, so nobody clicks to find out checking is not a thing here', async () => {
    useApp.setState({ platform: 'linux' });
    await renderPane();
    expect(screen.getByText(/does not update itself on Linux/)).toBeTruthy();
    expect(checkCalls).toEqual([]);
  });

  /*
   * The half of the split that moved. Windows gained an updater, so the
   * standing "this platform cannot" notice must be gone from it — and an
   * `unsupported` there now means the only thing it still can mean.
   */
  it.each(['darwin', 'win32'] as const)(
    'calls a development build a development build rather than a platform problem (%s)',
    async (platform) => {
      outcome = 'unsupported';
      useApp.setState({ platform });
      await renderPane();
      await clickCheck();

      expect(screen.getByText('This build cannot update itself.')).toBeTruthy();
      expect(screen.getByText(/development build/)).toBeTruthy();
      // And no standing platform notice: an installed build on either of these
      // updates itself.
      expect(screen.queryByText(/does not update itself on/)).toBeNull();
    },
  );

  it('shows the channel without offering a second switch over it', async () => {
    useApp.setState({ updateChannel: 'beta' });
    await renderPane();

    expect(screen.getByText('Beta releases')).toBeTruthy();
    expect(screen.getByText(/switch is in This machine/)).toBeTruthy();
    // The This machine pane owns that preference. A rival control here is the
    // thing this pane deliberately does not have.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('reports a download in flight, with the progress the state carries', async () => {
    state = {
      ...IDLE,
      phase: 'working',
      version: '1.5.0',
      progress: { step: 'downloading', transferred: 84_000_000, total: 196_000_000 },
    };
    await renderPane();

    expect(screen.getByText(/Downloading 1\.5\.0/)).toBeTruthy();
    expect(screen.getByText('84.0 MB of 196.0 MB')).toBeTruthy();
  });
});
