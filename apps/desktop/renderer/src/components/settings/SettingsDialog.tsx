/**
 * The settings surface.
 * ============================================================================
 *
 * One large dialog with its own section nav, replacing what used to be a
 * full-screen profiles page laid over the conversation.
 *
 * ---------------------------------------------------------------------------
 * WHY A DIALOG AND NOT A SCREEN
 * ---------------------------------------------------------------------------
 *
 * The old surface was `absolute inset-0` over the app: it hid the conversation
 * completely, it had no relationship to what the user was doing when they
 * opened it, and every new settings pane made it look more like a second
 * application. A modal keeps the conversation visible behind it, which is the
 * honest picture — settings change the *next* run, and the run they are about
 * to change is right there.
 *
 * The cost of a modal is that it is usually too small, and a cramped dialog
 * would be a straight regression from a full screen. So this one is
 * deliberately large — most of the window, capped against the viewport — and
 * the height is fixed rather than content-driven, because a dialog that
 * changes size when you switch section makes the nav feel like it is moving
 * under the pointer.
 *
 * ---------------------------------------------------------------------------
 * ONE SCROLL CONTAINER
 * ---------------------------------------------------------------------------
 *
 * The content pane scrolls; the dialog does not, and neither does the nav. That
 * is the whole reason for the `min-h-0` on the flex row — without it a tall
 * pane grows the flex item instead of scrolling inside it, the dialog exceeds
 * the viewport, and the page behind starts scrolling instead. Panes are written
 * to assume they are inside this one scroller and never make another.
 *
 * ---------------------------------------------------------------------------
 * STATE LIVES IN THE STORE
 * ---------------------------------------------------------------------------
 *
 * Open/closed is `screen === 'profiles'` — the historical name for "settings is
 * open", kept because every existing `setScreen('profiles')` call site is a
 * correct request to open this — and the pane is `settingsSection`. Neither is
 * local state: the command palette, the model picker's "manage models" link and
 * the ⌘, hotkey all need to open this dialog *on a particular pane* — sometimes
 * on a particular row of it (`settingsRow`, the `data-settings-row` anchors) —
 * and a component that owned its own section could not be aimed from outside.
 * Sections are *addresses*: the store's `resolveSettingsSection` maps ids whose
 * panes have since merged onto the pane that answers for them now, so old deep
 * links and old preference files keep working across reorganisations.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import {
  BotIcon,
  BoxesIcon,
  BrainIcon,
  CalendarClockIcon,
  CastIcon,
  GaugeIcon,
  InfoIcon,
  KeyRoundIcon,
  LaptopIcon,
  PaletteIcon,
  ServerIcon,
  ShieldIcon,
  VaultIcon,
} from 'lucide-react';

import { ProfilesSection } from '../ProfilesScreen';
import { AboutSection } from './AboutSection';
import { AdvancedSection } from './AdvancedSection';
import { AppearanceSection } from './AppearanceSection';
import { InstructionsSection } from './InstructionsSection';
import { KeyManagersSection } from './KeyManagersSection';
import { MemoryBanksSection } from './MemoryBanksSection';
import { ModelsSection } from './ModelsSection';
import { PermissionsSection } from './PermissionsSection';
import { RemoteSection } from './RemoteSection';
import { RunsSection } from './RunsSection';
import { ServerSection } from './ServerSection';
import { RoutinesSection } from './RoutinesSection';
import {
  clearSettingsRow,
  closeSettings,
  resolveSettingsSection,
  setSettingsSection,
  useApp,
  type SettingsSection,
} from '../../state/store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface SectionEntry {
  readonly id: SettingsSection;
  readonly label: string;
  /** Four words at most — the nav is 13rem wide and this sits under the label. */
  readonly hint: string;
  readonly icon: ReactElement;
}

interface NavBand {
  /** The small-caps rule over the band. */
  readonly label: string;
  readonly sections: readonly SectionEntry[];
}

/**
 * The nav: two bands, each in the order its panes were designed to be met.
 *
 * The bands are the real division in what this dialog holds. Everything in
 * the first configures *your* work — accounts, models, runs, what the agent is
 * told and allowed, how it all looks. Everything in the second is about the
 * app as a fixture on this computer: lending the accounts out, spending them
 * on a schedule, and the facts that stay behind when a profile moves on. A
 * flat list buried that seam, and the panes at the bottom read as an appendix
 * rather than as a different kind of question.
 *
 * Only canonical ids appear here. The historical addresses — `browser`,
 * `cerebro` — still resolve (see `resolveSettingsSection`), they just no
 * longer earn a row: a nav entry per address would draw two doors into one
 * room.
 *
 * Exported for the nav-shape test, which exists so that a future rename or
 * reorder breaks an assertion instead of a deep link.
 */
export const SETTINGS_NAV: readonly NavBand[] = [
  {
    label: 'Settings',
    sections: [
      // Profiles first because without one nothing else in this dialog can be
      // answered: the model catalogue is fetched with a profile's credential,
      // and the permission modes come from the provider that profile names.
      {
        id: 'profiles',
        label: 'Profiles',
        hint: 'Accounts and sign-in',
        icon: <KeyRoundIcon aria-hidden="true" />,
      },
      {
        id: 'models',
        label: 'Models',
        hint: 'Catalogue and quick access',
        icon: <BoxesIcon aria-hidden="true" />,
      },
      // After the catalogue and before everything the run carries: Runs is
      // where the next run's shape is decided — flags, the end-of-run report,
      // the handover — and deciding it means knowing what the models can do,
      // which is the pane directly above.
      {
        id: 'runs',
        label: 'Runs',
        hint: 'Speed, spend, handover',
        icon: <GaugeIcon aria-hidden="true" />,
      },
      // The id keeps its historical name: deep links (`openSettings('agents')`)
      // predate the rename, and an id is an address, not a label. The pane
      // holds the standing prompts — text the user writes and every run
      // carries.
      {
        id: 'agents',
        label: 'Instructions',
        hint: 'Standing prompts',
        icon: <BotIcon aria-hidden="true" />,
      },
      // Directly under Instructions, because it is the same question answered
      // by a repository instead of by a paragraph: the prompts are what the
      // user states, a bank is what the agents maintain. They shared a pane
      // for a while and the banks outgrew it — a bank now carries a name, a
      // format, a set of profiles and a validation report, none of which fits
      // under someone else's heading.
      {
        id: 'memory-banks',
        label: 'Memory banks',
        hint: 'Shared facts agents keep',
        icon: <BrainIcon aria-hidden="true" />,
      },
      // After what the agent is told, what it is allowed: the browser
      // switches live in here now — "whose browser" was always a permission
      // question, and the old nav's answer (a separate pane, parked adjacent,
      // "in the same breath") was the weaker form of putting them in the same
      // sentence. The `browser` id still resolves to this pane.
      {
        id: 'permissions',
        label: 'Permissions & access',
        hint: 'What runs without asking',
        icon: <ShieldIcon aria-hidden="true" />,
      },
      // Last in the band because nothing depends on it and it changes nothing
      // about a run: pure taste, safely explored after the questions with
      // consequences are settled.
      {
        id: 'appearance',
        label: 'Appearance',
        hint: 'Theme, width and layout',
        icon: <PaletteIcon aria-hidden="true" />,
      },
    ],
  },
  {
    label: 'This machine',
    sections: [
      // First in its band because it is what the band above reaches for: the
      // Instructions pane offers a memory bank "from a key manager", and this
      // is the pane that makes that offer real. A connection is also the
      // plainest thing this band holds — an address, a trusted CA and a token,
      // all of them facts about this computer rather than about a profile —
      // so crossing the seam lands on the least surprising pane behind it.
      {
        id: 'secrets',
        label: 'Key managers',
        hint: 'Secrets fetched, not stored',
        icon: <VaultIcon aria-hidden="true" />,
      },
      // Below everything that describes what Artemis does for its own user,
      // because this is the one pane that is not about that: it decides
      // whether *other programs* may use the accounts the band above
      // configures. Meeting it before Profiles would be being offered the
      // door before the room.
      {
        id: 'server',
        label: 'Server',
        hint: 'Lend models to other apps',
        icon: <ServerIcon aria-hidden="true" />,
      },
      // The server's mirror, and directly under it on purpose: Server lends
      // this machine's accounts out, Remote borrows another machine's whole
      // Artemis — one grant model (a token, minted over there), one mental
      // model, two directions.
      {
        id: 'remote',
        label: 'Remote',
        hint: 'Drive another machine',
        icon: <CastIcon aria-hidden="true" />,
      },
      // Beside the server on purpose: both panes are the app acting without a
      // person at the keyboard — one lends the accounts out, this one spends
      // them on a schedule. A user weighing one has the vocabulary for the
      // other.
      {
        id: 'routines',
        label: 'Routines',
        hint: 'Runs on a schedule',
        icon: <CalendarClockIcon aria-hidden="true" />,
      },
      // Last of the panes that decide anything, and last of them on purpose:
      // nothing above it depends on anything in it. The id keeps its
      // historical name — the pane was called Advanced when its contract was
      // "scripts you run yourself", and the address outlives the contract.
      // What it holds now is whatever is scoped to this installation: the
      // shared-config scripts, the folder record, the update channel.
      {
        id: 'advanced',
        label: 'This machine',
        hint: 'Scripts, folders, updates',
        icon: <LaptopIcon aria-hidden="true" />,
      },
      // Below even that, because it is the only pane in the dialog that
      // configures nothing at all: it reports what this copy of Artemis *is*
      // and offers the one action that is about the app rather than about the
      // work. Bottom of the list is where people look for "About" without
      // being told, which matters more here than for any other row — until
      // this pane existed the version was on no screen and a check could only
      // be asked for from the macOS menu bar, so everyone else had nowhere to
      // go. It sits in this band rather than the one above for the reason the
      // band exists: a version and an updater are facts about the app on this
      // computer, not about how the agent works.
      {
        id: 'about',
        label: 'About',
        hint: 'Version and updates',
        icon: <InfoIcon aria-hidden="true" />,
      },
    ],
  },
];

export function SettingsDialog(): ReactElement {
  const open = useApp((s) => s.screen === 'profiles');
  // Resolved on the way out as well as on the way in: `openSettings` and
  // `setSettingsSection` already canonicalise, but a persisted value from an
  // older build reaches this component without passing through either, and a
  // nav highlighting nothing is what an unresolved `cerebro` would produce.
  const section = resolveSettingsSection(useApp((s) => s.settingsSection));
  const row = useApp((s) => s.settingsRow);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  /*
   * The second half of a deep link: scroll the anchored row into view once the
   * pane holding it has mounted. One frame after, not immediately — the panes
   * render synchronously but the dialog itself arrives through a portal, and
   * measuring before layout settles scrolls to where the row was about to be.
   * The anchor is then spent (`clearSettingsRow`), so switching sections or
   * reopening later does not replay a scroll nobody asked for twice.
   */
  useEffect(() => {
    if (!open || row === null) return undefined;
    const frame = requestAnimationFrame(() => {
      bodyRef.current
        ?.querySelector(`[data-settings-row="${row}"]`)
        ?.scrollIntoView({ block: 'start' });
      clearSettingsRow();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, section, row]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Only the close direction is handled here. Radix asks to *open* when a
        // trigger is activated, and this dialog has no trigger — every entry
        // point goes through `openSettings`, which can also aim it at a pane.
        if (!next) closeSettings();
      }}
    >
      <DialogContent
        // `sm:max-w-*` has to be restated: the base content class pins itself to
        // `sm:max-w-sm` at every breakpoint above mobile, which would quietly
        // shrink this to a tooltip-sized box on any real window.
        className="flex h-[min(660px,calc(100dvh-3rem))] w-[calc(100vw-3rem)] max-w-[1000px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1000px]"
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-hairline px-4 py-3">
          <DialogTitle className="text-sm font-semibold tracking-tight text-ink">
            Settings
          </DialogTitle>
          <DialogDescription className="text-2xs leading-snug">
            Everything here applies to the next run. Nothing changes a run already in flight.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Settings sections"
            className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-hairline p-2"
          >
            {SETTINGS_NAV.map((band, index) => (
              <div key={band.label} className="flex flex-col gap-0.5">
                <h3
                  className={cn(
                    'chrome-label px-2.5 pb-1 text-ink-faint',
                    index === 0 ? 'pt-1' : 'pt-3',
                  )}
                >
                  {band.label}
                </h3>
                {band.sections.map((entry) => {
                  const active = entry.id === section;
                  return (
                    <Button
                      key={entry.id}
                      // Not `variant="secondary"` for the active row, which is
                      // what this reached for first: `--secondary` resolves to
                      // the `raised` surface, and inside a dialog — which is
                      // one step *above* raised — the "selected" fill came out
                      // darker than the panel it sits on and read as nothing at
                      // all. A wash cannot have that problem: it is a fraction
                      // of the ink laid over whatever is beneath, so it lifts
                      // the row off its own ground wherever the row is. Selected
                      // is `wash-strong`, hover is `wash`, which is the same
                      // pair the navigator columns and the `ChoiceList` use —
                      // one language for "this is the one".
                      variant="ghost"
                      size="lg"
                      // `aria-current` rather than `aria-pressed`: these are
                      // navigation, not toggles. A screen reader should say
                      // "current page", not "pressed".
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'h-auto w-full justify-start gap-2.5 rounded-md px-2.5 py-2 text-left',
                        active
                          ? 'bg-wash-strong text-ink hover:bg-wash-strong'
                          : 'text-ink-muted hover:bg-wash',
                      )}
                      onClick={() => setSettingsSection(entry.id)}
                    >
                      <span className={cn('shrink-0', active ? 'text-ink' : 'text-ink-faint')}>
                        {entry.icon}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-xs leading-snug font-medium">{entry.label}</span>
                        <span className="text-2xs leading-snug font-normal text-ink-faint">
                          {entry.hint}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* `min-h-0` on the row above plus this one is what makes the scroll
              land here instead of on the dialog. Removing either turns the
              content pane into a growing box and the modal into a page.

              Keyed by section so switching panes remounts the scroller at the
              top: the scroll position belongs to the pane being read, and
              arriving halfway down Permissions because Appearance was long is
              the dialog remembering the wrong thing. */}
          <ScrollArea key={section} className="min-h-0 flex-1">
            <div ref={bodyRef} className="mx-auto w-full max-w-3xl px-6 py-5">
              <SectionBody section={section} />
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Only the visible pane is mounted.
 *
 * Not an optimisation — the profiles pane holds an in-progress form, and
 * unmounting it when the user navigates away is the behaviour that keeps a
 * half-typed credential from surviving in the background where nothing on
 * screen suggests it still exists.
 */
function SectionBody({ section }: { readonly section: SettingsSection }): ReactElement {
  switch (section) {
    case 'models':
      return <ModelsSection />;
    case 'runs':
      return <RunsSection />;
    case 'appearance':
      return <AppearanceSection />;
    // The historical addresses share their homes' cases. They cannot arrive
    // here in practice — `SettingsDialog` resolves before rendering — but the
    // switch stays exhaustive over the union, so a legacy id someone routes
    // straight in still lands in the right room instead of failing to compile
    // away the case.
    case 'permissions':
    case 'browser':
      return <PermissionsSection />;
    case 'agents':
      return <InstructionsSection />;
    case 'memory-banks':
    case 'cerebro':
      return <MemoryBanksSection />;
    case 'secrets':
      return <KeyManagersSection />;
    case 'server':
      return <ServerSection />;
    case 'remote':
      return <RemoteSection />;
    case 'routines':
      return <RoutinesSection />;
    case 'advanced':
      return <AdvancedSection />;
    case 'about':
      return <AboutSection />;
    case 'profiles':
      return <ProfilesSection />;
  }
}
