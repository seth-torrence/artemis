/**
 * The About pane — which copy of Artemis this is, and how it gets a newer one.
 * ============================================================================
 *
 * Every other pane in this dialog decides something. This one reports, and it
 * exists because the two things it reports were, until it did, on no screen at
 * all:
 *
 *   - The **running version**. It was in the protocol as "for the about panel
 *     and bug reports", and there was no about panel; the only way to see it was
 *     to open the bug-report dialog, which is a strange thing to ask of someone
 *     who only wanted to know what they were running.
 *   - **A way to ask for an update check.** One existed, in the macOS
 *     application menu — a menu `installApplicationMenu` returns early from on
 *     every other platform. So for a Windows user the answer to "how do I check
 *     for updates?" was: you cannot, and nothing says so. Windows updates
 *     itself now, which makes the missing question worse rather than moot.
 *
 * ---------------------------------------------------------------------------
 * THE PANE'S OBLIGATION IS TO BE HONEST ABOUT WHAT IT CANNOT DO
 * ---------------------------------------------------------------------------
 *
 * macOS and Windows both update in place — a bundle swap on one, the NSIS
 * installer on the other — and Linux does not, because Artemis ships there as
 * AppImage, deb and pacman and two of those belong to a package manager. On
 * Linux `updater.ts` answers `unsupported` and makes **no network request at
 * all**.
 *
 * So on Linux this pane is mostly a notice, and the notice is the feature. The
 * failure it must never produce is the plausible one: a Check button that spins,
 * says "could not check for updates", and leaves the user debugging their proxy
 * for a request that was never sent. `unsupported` is therefore rendered as a
 * plain statement of how the app is built — not as an error, not in the failure
 * colour, and with no offer to try again — while `unreachable`, which really is
 * a network answer, gets the wording that sends someone to look at their
 * connection.
 *
 * The distinction between "this platform" and "this is a dev build" is drawn
 * here rather than in main, because main's `unsupported` covers both and the
 * renderer already knows the platform. Main growing a second outcome would be
 * main carrying a fact the renderer has.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO BETA SWITCH HERE
 * ---------------------------------------------------------------------------
 *
 * The channel is *shown* and not *set*. This machine owns that switch, and a
 * second one here would be two controls over one preference — the arrangement
 * where a user flips one, looks at the other, and cannot tell which is
 * authoritative. What this pane offers instead is the fact plus the way to the
 * control, which is what someone who came here looking for it actually needs.
 */

import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ExternalLinkIcon } from 'lucide-react';

import {
  ARTEMIS_RELEASES_URL,
  updatePercent,
  type UpdateCheckOutcome,
  type UpdateState,
} from '@rx-artemis/protocol';

import {
  checkForUpdates,
  installUpdate,
  restartForUpdate,
  useUpdateState,
} from '../../hooks/useUpdateState';
import { platformLabel } from '../../lib/bugReport';
import { byteLine, stepLabel } from '../../lib/updateFormat';
import { setSettingsSection, useApp } from '../../state/store';
import { CopyButton } from '../primitives';
import { SettingsGroup, SettingsPane } from './pane';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

/** The three platforms the bridge reports, named once so the props agree. */
type UpdateHost = 'darwin' | 'win32' | 'linux';

export function AboutSection(): ReactElement {
  const version = useApp((s) => s.version);
  const platform = useApp((s) => s.platform);
  const arch = useApp((s) => s.arch);
  const channel = useApp((s) => s.updateChannel);
  const state = useUpdateState();

  /*
   * What the last check answered, and whether one is in flight.
   *
   * Deliberately not derived from `state`: three of the five outcomes leave the
   * pushed state exactly as they found it, so a pane that read only the state
   * could not tell "up to date" from "unreachable" from "you have not asked".
   * `null` is that third thing, and it is why this starts empty rather than
   * claiming anything before the user has asked for it.
   */
  const [outcome, setOutcome] = useState<UpdateCheckOutcome | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async (): Promise<void> => {
    setChecking(true);
    // Cleared first, so a second click cannot leave the previous answer on
    // screen next to a button that says it is working — the one arrangement
    // where the reader cannot tell which question the sentence belongs to.
    setOutcome(null);
    try {
      setOutcome(await checkForUpdates());
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsPane
      title="About"
      description="Which copy of Artemis this is, and how it gets a newer one."
    >
      <BuildGroup version={version} platform={platform} arch={arch} />

      <SettingsGroup label="Updates">
        <ChannelRow channel={channel} />
        <AutomaticUpdates platform={platform} />

        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
          <ReleasesLink />
        </div>

        <CheckResult
          outcome={outcome}
          checking={checking}
          state={state}
          runningVersion={version}
          platform={platform}
        />
      </SettingsGroup>
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* The build                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The version, at the size of the thing the pane is for.
 *
 * Selectable text rather than a read-only input, because the two ways this
 * number leaves the app are a drag-select into a chat window and a click on the
 * copy button, and an `<input>` serves the first worse while implying it can be
 * edited. `select-text` is explicit: the dialog's chrome sets `select-none`
 * around it, which is right for furniture and wrong for the one string here
 * that is content.
 */
function BuildGroup({
  version,
  platform,
  arch,
}: {
  readonly version: string;
  readonly platform: UpdateHost;
  readonly arch: 'arm64' | 'x64' | 'other';
}): ReactElement {
  // An empty version means a window with no bridge at all, which renders
  // `DeadEnd` rather than this — but a blank line where a version belongs is the
  // one output that would look like a bug in Artemis rather than a missing fact.
  const shown = version === '' ? 'unknown' : version;

  return (
    <SettingsGroup label="This build">
      <Item size="sm" className="items-start">
        <ItemContent>
          <ItemTitle className="group/copy flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-ink select-text">
              Artemis {shown}
            </span>
            {version === '' ? null : (
              <CopyButton
                text={`Artemis ${version}`}
                label="Copy the version"
                className="relative shrink-0"
              />
            )}
          </ItemTitle>
          <ItemDescription className="line-clamp-none font-mono text-2xs text-ink-faint select-text">
            {platformLabel(platform)}
            {/* `other` prints nothing rather than a name like `ia32`: this sits
                above a link to per-architecture downloads, and an architecture
                that is on none of them is worse than silence. */}
            {arch === 'other' ? '' : ` · ${arch}`}
          </ItemDescription>
        </ItemContent>
      </Item>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Updates                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which releases this installation accepts, and where that is decided.
 *
 * A row, not a switch. The button navigates to the pane that owns the setting
 * rather than duplicating it — see the file header — which also means someone
 * who came to About looking for the beta option leaves knowing where it lives
 * instead of leaving without it.
 */
function ChannelRow({ channel }: { readonly channel: 'stable' | 'beta' }): ReactElement {
  return (
    <ItemGroup className="gap-0">
      <Item size="sm" className="items-start">
        <ItemContent>
          <ItemTitle className="text-xs text-ink">
            {channel === 'beta' ? 'Beta releases' : 'Stable releases'}
          </ItemTitle>
          <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
            {channel === 'beta'
              ? 'This installation is offered prereleases as well as stable ones. The switch is in This machine.'
              : 'This installation is offered stable releases only. Beta is switched on in This machine.'}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm" variant="ghost" onClick={() => setSettingsSection('advanced')}>
            Open This machine
          </Button>
        </ItemActions>
      </Item>
    </ItemGroup>
  );
}

/**
 * The standing notice, before anybody clicks anything.
 *
 * Shown on the platform where the updater cannot run at all, and shown
 * *unprompted*, because the alternative is a person clicking Check for updates
 * to discover that checking is not a thing their build does. A notice that only
 * appears after the click would be answering a question the pane could have
 * answered before it was asked.
 *
 * Nothing here on macOS or Windows: both update themselves, and a dev build's
 * inability to is a fact about the checkout rather than a caveat worth putting
 * over a pane every developer opens.
 */
function AutomaticUpdates({ platform }: { readonly platform: UpdateHost }): ReactElement | null {
  if (platform !== 'linux') return null;

  return (
    <div className="flex flex-col gap-1 bg-raised px-3 py-2.5">
      <span className="text-xs font-medium text-ink">
        Artemis does not update itself on {platformLabel(platform)}
      </span>
      <p className="text-2xs leading-relaxed text-ink-muted">
        macOS and Windows builds install their own updates — one swaps its application bundle, the
        other runs the installer it downloaded. There is no equivalent here: Artemis ships for Linux
        as an AppImage, a <span className="font-mono text-ink-faint">.deb</span> and a{' '}
        <span className="font-mono text-ink-faint">.pacman</span> package, and replacing a package
        is the package manager's job rather than the app's. Nothing is wrong with your network or
        your install: new versions are downloaded from the releases page and installed the way you
        installed this one.
      </p>
    </div>
  );
}

/**
 * What the last check said, in the place the button that asked it is.
 *
 * Inline rather than a dialog — the macOS menu item answers in a modal because
 * a menu has nowhere else to put a sentence, and a pane does. The wording splits
 * `unsupported` two ways on the platform, which is the distinction main cannot
 * draw for itself; see the file header.
 */
function CheckResult({
  outcome,
  checking,
  state,
  runningVersion,
  platform,
}: {
  readonly outcome: UpdateCheckOutcome | null;
  readonly checking: boolean;
  readonly state: UpdateState;
  readonly runningVersion: string;
  readonly platform: UpdateHost;
}): ReactElement | null {
  // An install in flight outranks whatever the last check said: the bytes are
  // the more recent news, and they are what the user is waiting on.
  if (state.phase === 'working') return <Working state={state} />;
  if (state.phase === 'ready') {
    return (
      <Answer tone="beam" title={`Artemis ${state.version ?? ''} is installed.`}>
        <p className="text-2xs leading-relaxed text-ink-muted">
          Restart to finish, or keep working — quitting normally picks it up on the next launch.
        </p>
        <Button size="sm" variant="secondary" className="self-start" onClick={restartForUpdate}>
          Restart now
        </Button>
      </Answer>
    );
  }

  if (checking || outcome === null) return null;

  switch (outcome) {
    case 'offered':
      return (
        <Answer tone="beam" title={`Artemis ${state.version ?? ''} is available.`}>
          <p className="text-2xs leading-relaxed text-ink-muted">
            You are running {runningVersion === '' ? 'an older version' : runningVersion}.
          </p>
          <Button size="sm" variant="secondary" className="self-start" onClick={installUpdate}>
            Download and install
          </Button>
        </Answer>
      );

    case 'current':
      return (
        <Answer tone="mint" title="Artemis is up to date.">
          <p className="text-2xs leading-relaxed text-ink-muted">
            {runningVersion === ''
              ? 'The release feed lists nothing newer than what you are running.'
              : `You are running ${runningVersion}, and the release feed lists nothing newer.`}
          </p>
        </Answer>
      );

    case 'unreachable':
      return (
        <Answer tone="amber" title="The update feed could not be reached.">
          <p className="text-2xs leading-relaxed text-ink-muted">
            Either the network is in the way, or the release this build looks for is not there. The
            check asks github.com for it anonymously, so nothing has changed about your install and
            nothing needs to be undone. The releases page is the manual route, and works whenever
            the feed does not.
          </p>
        </Answer>
      );

    case 'busy':
      return (
        <Answer tone="neutral" title="An update is already under way.">
          <p className="text-2xs leading-relaxed text-ink-muted">
            The update chip in the header has the details.
          </p>
        </Answer>
      );

    case 'unsupported':
      /*
       * Not the failure colour, and no retry. This is what the build *is*, not
       * something that went wrong with it — the check made no network request
       * to fail — and dressing it as an error is what would send a Linux user
       * to check their firewall.
       *
       * Two readings, because main's one outcome covers two facts: on Linux
       * it is the install — an Arch package updates itself, a `.deb` or an
       * AppImage does not — and on macOS or Windows, both of which do update
       * themselves when installed, it can only be a development build.
       */
      return (
        <Answer
          tone="neutral"
          title={
            platform === 'linux'
              ? 'This install of Artemis cannot update itself.'
              : 'This build cannot update itself.'
          }
        >
          <p className="text-2xs leading-relaxed text-ink-muted">
            {platform === 'linux'
              ? 'No check was made — there is nothing here for one to act on. Artemis updates itself where pacman installed it; a .deb or an AppImage is yours to replace. Download the version you want from the releases page and install it the way you installed this one.'
              : 'Updates replace an installed copy of Artemis. This one is running from a development build, where the installed app is the repository checkout.'}
          </p>
        </Answer>
      );
  }
}

/** The install this pane is watching, in the fewest lines that are still honest. */
function Working({ state }: { readonly state: UpdateState }): ReactElement {
  const percent = updatePercent(state.progress);
  const line = `${stepLabel(state.progress)} ${state.version ?? ''}`.trim();

  return (
    <Answer tone="beam" title={`${line}… keep Artemis open.`}>
      <Progress
        value={percent ?? undefined}
        aria-label={line}
        className={percent === null ? 'animate-pulse' : undefined}
      />
      {byteLine(state.progress) !== null && (
        <div className="text-right font-mono text-3xs text-ink-faint tabular-nums">
          {byteLine(state.progress)}
        </div>
      )}
    </Answer>
  );
}

/**
 * One answer, in a frame whose only variable is the colour of its heading.
 *
 * A shared frame rather than six hand-built blocks so that the outcomes read as
 * several answers to one question — the moment one of them grows its own border
 * treatment, the reader starts sorting them by severity instead of by content.
 *
 * No border of its own: it is a row of the enclosing `SettingsGroup`, which
 * draws the card and the hairline between rows. It carries its own padding, as
 * every non-row child of a group does.
 */
function Answer({
  tone,
  title,
  children,
}: {
  readonly tone: 'beam' | 'mint' | 'amber' | 'neutral';
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  const heading = {
    beam: 'text-beam-text',
    mint: 'text-mint',
    amber: 'text-amber',
    neutral: 'text-ink',
  }[tone];

  return (
    <div role="status" className="flex flex-col gap-2 px-3 py-2.5">
      <span className={cn('text-xs font-medium', heading)}>{title}</span>
      {children}
    </div>
  );
}

/**
 * The way out that never stops working.
 *
 * A plain anchor: the window-open guard in `main/security.ts` routes external
 * URLs to the system browser and refuses to navigate this window, so this is
 * already the safe external-open path and needs no channel of its own.
 */
function ReleasesLink(): ReactElement {
  return (
    <Button asChild size="sm" variant="ghost">
      <a href={ARTEMIS_RELEASES_URL} target="_blank" rel="noreferrer">
        Releases page
        <ExternalLinkIcon aria-hidden="true" />
      </a>
    </Button>
  );
}
