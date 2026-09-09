/**
 * Profile management.
 * ============================================================================
 *
 * A profile is a name and a config directory. That is the whole model, and it
 * is a deliberate collapse of what used to be here.
 *
 * ## What this screen used to ask for, and why it no longer does
 *
 * It asked for a provider, a hosting backend, an authentication mode, and a
 * pasted credential. Four decisions, of which the user could realistically make
 * one — and the instructions for the credential were, by then, impossible to
 * follow: they told the user to paste a token that the adapter had already
 * stopped emitting. The screen described a mechanism the app no longer had.
 *
 * What it actually has is simpler and better. `claude auth login`, run with
 * `CLAUDE_CONFIG_DIR` pointed at a directory, writes a credential belonging to
 * that directory alone. So a profile needs to know one thing — which directory
 * — and the account follows from it. There is no credential to paste, no
 * billing mode to choose (a plan is what Artemis supports), and no backend
 * (Bedrock, Vertex and Foundry went with the credential they authenticated).
 *
 * ## Three steps, in the order the user experiences them
 *
 *  1. **Name it and point it at a directory.** Artemis suggests one inside its
 *     own data directory; the user may replace it with any absolute path,
 *     which is how you attach a profile to the `~/.claude` you are already
 *     signed in to.
 *  2. **Run one command.** Artemis generates it, the user runs it in their own
 *     terminal. Artemis does not spawn it — see `signIn.ts` for why that was
 *     worse.
 *  3. **Artemis notices.** The screen polls the config directory and moves on by
 *     itself when the login lands.
 *
 * Step 3 is what makes step 2 tolerable: nobody has to come back and press a
 * button to tell the app what it can see for itself.
 *
 * ## Two rules that outlived the credential
 *
 *  - **Artemis performs no login.** Unchanged, and now structural rather than a
 *    policy — there is no code here that could grow into one.
 *  - **The directory is the account boundary.** Two profiles pointed at one
 *    directory are one account. That is allowed, because it is occasionally
 *    what someone means.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import {
  CheckIcon,
  CopyIcon,
  FolderSearchIcon,
  PaletteIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import {
  configDirProblem,
  isProfileAutoSelectable,
  isProfileEnabled,
  isSignInSettled,
  normalizeProfileColor,
  normalizeProfilePlanId,
  baseUrlProblem,
  defaultBaseUrlFor,
  plansForProvider,
  profileColorProblem,
  toolServersProblem,
} from '@rx-artemis/protocol';
import type { AuthStatusInfo, ProfileId, ProfileMetadata, ProviderId,
  ProviderKind, ServerAccountsListResponse, ServerSignInStatus,
  ToolServerConfig } from '@rx-artemis/protocol';

import { hasNativeDirectoryPicker, NO_PICKER_REASON, pickDirectory } from '../lib/extensions';
import { shortenPath } from '../lib/paths';
import {
  cancelServerSignIn,
  createProfile,
  createServerAccount,
  deleteProfile,
  deleteServerAccount,
  readAuthStatus,
  readServerAccounts,
  readServerSignIn,
  refreshModels,
  signOutProfile,
  startServerSignIn,
  submitServerSignInCode,
  suggestConfigDir,
  updateProfile,
  updateServerAccount,
  useApp,
} from '../state/store';
import { usePane } from '../state/paneContext';
import { IconButton, ReasonButton } from './disabled-reason';
import { ProfilePlanUsage } from './PlanUsageMeter';
import { useCopy } from '@/hooks/useCopy';
import { CodeBlock, ProfileSwatch, ToneBadge } from './primitives';
import { SettingsPane } from './settings/pane';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { bindingWindow } from '@rx-artemis/protocol';
import { toneFor } from './PlanUsageMeter';

/**
 * How often the sign-in step re-reads the config directory.
 *
 * Each poll spawns a short-lived status subprocess (`claude auth status`,
 * `codex login status`), so this is a trade between "the screen feels dead" and
 * "the machine is busy". Two seconds is comfortably under the time it takes to
 * complete a browser login, and the poll only runs while the sign-in step is
 * actually on screen.
 */
const POLL_INTERVAL_MS = 2_000;

/**
 * Where each provider's CLI keeps its config by default.
 *
 * Used for the directory placeholder and the "point it at your existing one"
 * hint, so a Codex profile is not offered `~/.claude` as an example. Presentation
 * only — the authoritative variable name lives on the adapter's
 * `ProviderCredentialSpec`, which the renderer never sees.
 */
/**
 * The two halves of the provider picker, in the order they are shown.
 *
 * Hosted first because that is what most people are here for, and local
 * beneath it: a model on your own machine is the deliberate choice, not the
 * default one.
 */
const PROVIDER_GROUPS: readonly { readonly kind: ProviderKind; readonly heading: string }[] = [
  { kind: 'hosted', heading: 'Hosted — signed in to an account' },
  // "You run", not "this machine": the Artemis row in this half is usually a
  // server on another machine, reached through a tunnel. What the group really
  // shares is the entry model — an address and maybe a key, no account.
  { kind: 'local', heading: 'Local — a server you run' },
];

const CONVENTIONAL_CONFIG_DIR: Readonly<Record<ProviderId, string>> = {
  claude: '.claude',
  codex: '.codex',
  opencode: '.config/opencode',
  /**
   * The odd one out, and deliberately empty.
   *
   * The other three name a directory a CLI already keeps its account in, which
   * is what makes "point it at your existing one" a useful hint. A local
   * inference server has no such directory — a profile here is defined by an
   * *endpoint*, not by an account on disk — so offering a path to reuse would
   * be inventing a convention rather than reporting one.
   */
  lmstudio: '',
  ollama: '',
  llamacpp: '',
  // Same rule as the three above: the profile is an endpoint, not an account
  // on this disk. The serving Artemis keeps the sessions on its own machine.
  artemis: '',
};

export function ProfilesSection(): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const activeId = usePane((s) => s.activeProfileId);
  const [editing, setEditing] = useState<string | null>(null);
  /**
   * Open the create form immediately when there are none.
   *
   * The first-run case: an empty pane with a "New profile" button is a dead end
   * for a user who has no idea what a profile is, and every other pane in this
   * dialog needs one to exist before it can answer anything.
   */
  const [creating, setCreating] = useState(profiles.length === 0);

  return (
    <SettingsPane
      title="Profiles"
      description="Each profile is one provider account and its own history, kept in its own config directory. Switching is manual — Artemis never pools accounts or rotates them for you."
      actions={
        creating ? null : (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon />
            New profile
          </Button>
        )
      }
    >
      {/* The address the status line's "Manage" scrolls to — see
          `openSettings(section, { row })`. Frozen like the section ids. */}
      <div data-settings-row="profile-list" className="flex flex-col gap-3">
        {profiles.length === 0 && !creating ? (
          <p className="text-xs text-ink-muted">No profiles yet.</p>
        ) : null}

        {profiles.map((profile) =>
          editing === profile.id ? (
            <ProfileForm
              key={profile.id}
              profile={profile}
              onDone={() => setEditing(null)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <ProfileCard
              key={profile.id}
              profile={profile}
              active={profile.id === activeId}
              onEdit={() => setEditing(profile.id)}
            />
          ),
        )}

        {creating ? <CreateProfileFlow onDone={() => setCreating(false)} /> : null}

        <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
          Artemis stores no credential of any kind. Signing in runs the provider’s own CLI against
          the profile’s config directory, and the credential it writes stays there — Artemis sets one
          environment variable and reads back whether it worked.
        </p>
      </div>
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* Login state                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read one profile's login state, and keep it fresh while `poll` is true.
 *
 * Polling is opt-in per caller rather than always-on: the card list wants one
 * reading on mount, while the sign-in step wants to watch. An always-polling
 * hook would spawn a subprocess per profile per interval for a screen that is
 * usually just sitting there.
 */
function useAuthStatus(
  profileId: string | undefined,
  poll: boolean,
): { readonly status: AuthStatusInfo | undefined; readonly command: string; readonly checking: boolean } {
  const cached = useApp((s) => (profileId === undefined ? undefined : s.authByProfile[profileId]));
  const [command, setCommand] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (profileId === undefined) return;
    let cancelled = false;

    const read = async (): Promise<void> => {
      setChecking(true);
      const result = await readAuthStatus(profileId);
      if (cancelled) return;
      setChecking(false);
      if (result) setCommand(result.signInCommand);
    };

    void read();
    if (!poll) return () => {
      cancelled = true;
    };

    const timer = setInterval(() => void read(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [profileId, poll]);

  return { status: cached, command, checking };
}

/** One line describing who a directory is signed in as. */
function describeAccount(status: AuthStatusInfo | undefined): string {
  if (!status) return 'checking…';
  if (!status.loggedIn) return status.error ?? 'not signed in';
  const plan = status.subscriptionType ?? status.authMethod;
  return [status.email ?? status.orgName ?? 'signed in', plan].filter(Boolean).join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

function ProfileCard({
  profile,
  active,
  onEdit,
}: {
  readonly profile: ProfileMetadata;
  readonly active: boolean;
  readonly onEdit: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [alsoHistory, setAlsoHistory] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const platform = useApp((s) => s.platform);
  const { status } = useAuthStatus(profile.id, signingIn);

  // This profile's provider, not the active one. A card on this screen can
  // belong to a provider the app is not currently pointed at, and degrading it
  // against whatever happens to be selected would say "does not report plan
  // usage" about a provider that does.
  const provider = useApp((s) => s.providers.find((p) => p.id === profile.providerId));
  const usageSupported = provider?.capabilities.planUsageReporting ?? false;
  const providerLabel = provider?.label ?? profile.providerId;

  // Undefined means "not read yet", which must not render as signed out — the
  // difference between "we do not know" and "you are not signed in" is the
  // difference between a quiet dash and an amber warning.
  const known = status !== undefined;
  const signedIn = status?.loggedIn === true;

  // Stop watching once the login lands. The step below collapses on its own.
  useEffect(() => {
    if (signedIn) setSigningIn(false);
  }, [signedIn]);

  return (
    <Card
      size="sm"
      className={cn('rounded-lg border-hairline', active ? 'bg-wash-strong' : 'bg-panel')}
    >
      <CardContent className="flex flex-col gap-1.5">
        {/*
          Only problems get a badge.
          ------------------------------------------------------------------
          `active` and `signed in` were both badges that said the expected
          thing. A row of them trains the eye to skip the badge slot, which is
          the one place a real problem has to be noticed — and `signed out`,
          the only badge that needs acting on, was sitting in a line of green
          and orange reassurance.

          Neither fact is lost. Active is the card's wash fill — the same
          "this is the one" ground every other selected row and tab in the app
          now uses, in place of the beam ring it used to carry — which reads
          faster than a word and does not compete for the same slot; signed-in
          is the account line below, which names the account rather than
          asserting that one exists.

          The two availability states earn a badge under the same rule, from
          the other direction: neither is a problem, but both are the card
          contradicting what the rest of the app shows. This screen is the only
          place a hidden account appears at all, so if the state is not on the
          card it is nowhere — and "why is this one never picked?" is
          unanswerable by looking. Toneless, because nothing is wrong; only one
          of the two ever shows, because a hidden account is not separately
          worth telling you it is also not being suggested.
        */}
        <div className="flex items-center gap-2">
          <ProfileSwatch color={profile.color} className="size-2.5" />
          <span className="shrink-0 text-sm font-medium text-ink">{profile.label}</span>
          {/*
            The config directory, promoted to the title row. It is what makes
            two profiles different — the label is a nickname, the directory is
            the account — so it belongs beside the name rather than below the
            account line where it read as a footnote.
          */}
          <span
            className="min-w-0 truncate font-mono text-2xs text-ink-faint"
            title={profile.configDir}
          >
            {shortenPath(profile.configDir, { platform, max: 40 })}
          </span>
          {known && !signedIn ? <ToneBadge tone="amber">signed out</ToneBadge> : null}
          {!isProfileEnabled(profile) ? (
            <ToneBadge>disabled</ToneBadge>
          ) : !isProfileAutoSelectable(profile) ? (
            <ToneBadge>not suggested</ToneBadge>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Button size="xs" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            {/*
              Not an `AlertDialogTrigger asChild`: `IconButton` renders a
              tooltip-wrapped button, and `asChild` needs a single element that
              forwards a ref to the DOM — a Radix `Tooltip.Root` is not one. The
              dialog is controlled instead, which costs one boolean and keeps
              the button's accessible name and tooltip intact.
            */}
            <IconButton
              label="Delete profile"
              size="icon-xs"
              className="text-signal"
              onClick={() => setConfirming(true)}
            >
              <Trash2Icon />
            </IconButton>
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-2xs">
          <span className="text-ink-faint">account</span>
          <span className={known && !signedIn ? 'text-amber' : 'text-ink-muted'}>
            {describeAccount(status)}
          </span>
        </div>

        {/*
          What is left of this account, on the screen where accounts are
          managed. Deciding which profile to switch to is a question about
          headroom — "the one that is not out of weekly" — and answering it
          used to mean switching to each account in turn and opening the status
          bar gauge, which is the switch the user was trying to make an
          informed choice about.

          Only for a signed-in profile: a signed-out one has no limits to
          report, and an empty meter under a sign-in button reads as a limit of
          zero rather than as an unanswered question.
        */}
        {/*
          Not for a server profile, though its provider now reports plan usage:
          a server's readings are per served account and live on the account
          rows below, where each wears its own gauge. One meter for "the
          server" would claim a single answer for several accounts.
        */}
        {signedIn && profile.providerId !== 'artemis' ? (
          <div className="mt-1 border-t border-hairline pt-2">
            <ProfilePlanUsage
              profileId={profile.id}
              supported={usageSupported}
              providerLabel={providerLabel}
            />
          </div>
        ) : null}

        {/*
          The sign-in affordance lives on the card, not only in the create
          flow. A credential expires, a user signs out elsewhere, an account
          gets switched — and every one of those leaves an existing profile
          needing exactly the step the create flow ends with.
        */}
        {known && !signedIn && !signingIn ? (
          <div className="mt-1">
            <Button size="xs" variant="outline" onClick={() => setSigningIn(true)}>
              Sign in
            </Button>
          </div>
        ) : null}

        {signingIn ? (
          <div className="mt-1">
            <SignInStep profileId={profile.id} onDone={() => setSigningIn(false)} />
          </div>
        ) : null}

        {/*
          The other kind of account, on the card for the profile that names the
          server it lives on.
          ------------------------------------------------------------------
          Deliberately its own section rather than a change to the sign-in step
          above. That step is about *this* profile's credential — for an Artemis
          Server profile, the connection token, which is already in hand by the
          time the card exists and is why it reports "signed in" the instant it
          is asked. This is about accounts on the far machine, which is a
          different set of things with a different lifecycle, and folding the
          two together would have one "Sign in" button meaning two unrelated
          jobs depending on which row you were looking at.
        */}
        {profile.providerId === 'artemis' ? (
          <ServerAccountsSection profileId={profile.id} />
        ) : null}

        {/*
          A modal rather than an inline panel. Deleting a profile is
          irreversible, and an inline confirm inside a scrolling list can be
          triggered by a stray click on a row that has since moved.
          `AlertDialog` takes the focus, traps it, and makes Escape mean cancel.

          `alsoHistory` is reset on close, not only on confirm: leaving it on
          would carry a much larger deletion over to whichever profile the user
          opened this on next.
        */}
        <AlertDialog
          open={confirming}
          onOpenChange={(next) => {
            setConfirming(next);
            if (!next) setAlsoHistory(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-signal/10 text-signal">
                <TriangleAlertIcon />
              </AlertDialogMedia>
              <AlertDialogTitle className="text-sm text-ink">
                Delete “{profile.label}”?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-2xs leading-relaxed">
                The profile record is removed from Artemis. The config directory it points at —
                including the login inside it — is left alone unless you ask below.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="flex items-start gap-2 rounded-lg border border-hairline bg-inset/60 px-3 py-2">
              <Switch
                id={`delete-history-${profile.id}`}
                size="sm"
                className="mt-px"
                checked={alsoHistory}
                onCheckedChange={setAlsoHistory}
              />
              <Label
                htmlFor={`delete-history-${profile.id}`}
                className="text-2xs leading-relaxed font-normal text-ink-muted"
              >
                Also delete the config directory and its session history. Artemis only does this for
                directories it created itself — one you chose, such as your own{' '}
                <code className="font-mono">~/.claude</code> or{' '}
                <code className="font-mono">~/.codex</code>, is never deleted.
              </Label>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Keep it</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => void deleteProfile(profile.id, alsoHistory)}
              >
                Delete profile
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create, then sign in — one card, two steps.
 *
 * The profile is written to disk between them. That ordering is not incidental:
 * the sign-in command names the config directory, and until the profile exists
 * there is nothing to name or to poll. It also means an interrupted sign-in
 * leaves a real profile that the card list can offer to finish, rather than
 * losing the user's work because they closed a dialog.
 */
function CreateProfileFlow({ onDone }: { readonly onDone: () => void }): ReactElement {
  const [createdId, setCreatedId] = useState<string | null>(null);

  if (createdId === null) {
    return <ProfileForm onDone={setCreatedId} onCancel={onDone} />;
  }

  return (
    <Card size="sm" className="rounded-lg border-hairline bg-wash-strong">
      <CardContent className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-ink">Sign in</h2>
        <SignInStep profileId={createdId} onDone={onDone} />
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Sign-in step                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The command, and the wait.
 *
 * Artemis generates the line, the user runs it, and this polls until the config
 * directory says a credential arrived. Nothing here spawns the login — see
 * `@rx-artemis/core`'s `signIn.ts` for the three specific ways that went wrong
 * when it did.
 */
function SignInStep({
  profileId,
  onDone,
}: {
  readonly profileId: string;
  readonly onDone: () => void;
}): ReactElement {
  const { status, command, checking } = useAuthStatus(profileId, true);
  // The profile's provider, not the active one — the same rule `ProfileCard`
  // follows. `command` already comes from the profile's own adapter, so reading
  // the prose off the active provider was a way to explain a `codex login` in
  // Claude's words.
  const fallback = usePane((s) => s.activeProviderId);
  const provider = useApp((s) => {
    const owner = s.profiles.find((p) => p.id === profileId)?.providerId;
    return s.providers.find((p) => p.id === (owner ?? fallback));
  });
  const signedIn = status?.loggedIn === true;

  // The tick is set only once the write has resolved, and a failure says so —
  // see `useCopy` for why that ordering is load-bearing rather than fussy.
  const [copied, copy] = useCopy(command, {
    title: 'Could not copy the command',
    description: 'Select the line above and copy it by hand.',
  });

  if (signedIn) {
    return (
      <div className="flex flex-col gap-2">
        <Alert className="border-sage/40 bg-sage/5">
          <CheckIcon />
          <AlertTitle className="text-2xs text-sage">Signed in</AlertTitle>
          <AlertDescription className="font-mono text-2xs text-ink-muted">
            {describeAccount(status)}
          </AlertDescription>
        </Alert>
        <div>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs leading-relaxed text-ink-muted">
        {provider?.signInHowTo ??
          'Run this in a terminal to sign this profile in. Artemis watches its config directory and continues on its own.'}
      </p>

      <div className="flex items-start gap-2">
        <CodeBlock text={command || 'preparing…'} className="min-w-0 flex-1" />
        <Button
          size="xs"
          variant="outline"
          onClick={copy}
          disabled={command.length === 0}
          aria-label="Copy the sign-in command"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {/*
        A read that *failed* is not the same as a directory that is signed out,
        and the two need different reactions from the user: one means "finish
        the login", the other means "your CLI is not where Artemis can run it".
        Only the second is worth interrupting for.
      */}
      {status?.error ? (
        <Alert variant="destructive" className="border-signal/40 bg-signal/5">
          <TriangleAlertIcon />
          <AlertDescription className="font-mono text-2xs text-signal">
            {status.error}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-2 text-2xs text-ink-faint">
        {checking ? <Spinner className="size-3" /> : null}
        <span>Waiting for the login to complete — this updates by itself.</span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onDone}>
          Finish later
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Accounts on the server                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How often the remote sign-in is re-read while it is on screen.
 *
 * Faster than {@link POLL_INTERVAL_MS} because this poll is one small HTTP
 * request rather than a subprocess spawn, and because what it is waiting for —
 * a URL appearing, a code being accepted — is something the user is watching
 * for right now. It only runs while a flow is live.
 */
const SIGN_IN_POLL_MS = 1_200;

/**
 * The accounts a *remote* Artemis serves, and adding one.
 * ============================================================================
 *
 * ## Why this exists
 *
 * A headless Artemis is worth nothing until an account is signed into it, and
 * signing one in used to mean a shell inside its container: `profile add`, then
 * the provider's login, run in a terminal that an orchestrated deployment does
 * not reliably have — and whose web version, served over plain HTTP, cannot
 * even paste. The account that makes the server useful was the one thing the
 * deployment could not install.
 *
 * So the login runs on the server and the *person* is here. The server spawns
 * the provider's CLI, which with no browser to open prints a verification URL
 * and waits on stdin; this pane shows the URL, takes what the user pastes back,
 * and hands it over. Two strings cross the wire and neither is a credential —
 * the CLI writes its own token into its own directory, in that container.
 *
 * ## Why the URL is rendered as plain text with an ordinary link
 *
 * It arrives from a subprocess on another machine, and it is put in front of a
 * user with an invitation to sign in at it. That is a phishing surface by
 * construction, so it is shown exactly as it arrived — no shortening, no
 * markdown, no following a redirect to show a "friendlier" name. What the user
 * judges is the address they will actually visit. The anchor carries no
 * `target`: `main/security.ts` intercepts navigation out of the renderer and
 * hands it to the system browser, so being a link is the whole of what is
 * needed.
 */
/**
 * One served account's gauge, from the poller's fan-out.
 *
 * The binding window — the one that will actually stop you — as a percentage,
 * in the meter's own tones. Renders nothing while no reading has landed or
 * the account has no plan to read: an empty chip would claim a fact nobody
 * has.
 */
/**
 * What a served account's row says about its sign-in, and how loudly.
 *
 * Four answers, because there are four states and the two that used to be
 * conflated are the ones that matter. `live` — "the account confirmed this
 * catalogue" — was standing in for this, and for a provider whose model list
 * needs no credential to enumerate it reads as signed in when the account has
 * no credential at all. That is how a server with one broken account showed
 * five identical rows, every one offering "Sign in again".
 *
 * An absent `auth` is a server too old to be asked, or one that cannot probe.
 * It says so rather than picking whichever guess looks tidier — which is the
 * one thing it must not share with {@link describeAccount}, the local-profile
 * counterpart, where an absent status means the poll has not answered *yet*
 * and "checking…" is the truth.
 */
export function describeAccountAuth(auth: AuthStatusInfo | undefined): {
  readonly text: string;
  readonly tone: string;
  readonly detail?: string;
} {
  if (auth === undefined) return { text: 'sign-in not checked', tone: 'text-ink-faint' };
  // A failed read is not a signed-out account: sending someone to a login that
  // cannot work is worse than saying the check itself is broken.
  if (auth.error !== undefined) {
    return { text: 'sign-in unreadable', tone: 'text-amber', detail: auth.error };
  }
  if (!auth.loggedIn) return { text: 'signed out', tone: 'text-amber' };
  return {
    text: 'signed in',
    tone: 'text-ink-faint',
    ...(auth.email === undefined ? {} : { detail: auth.email }),
  };
}

function ServerAccountGauge({
  profileId,
  accountId,
}: {
  readonly profileId: string;
  readonly accountId: string;
}): ReactElement | null {
  const reading = useApp((s) => s.planUsageByServerAccount[`${profileId}/${accountId}`]);
  if (reading === undefined || !reading.usage.available) return null;
  const window = bindingWindow(reading.usage);
  if (window === null || window.utilization === null) return null;
  // `utilization` is already 0–100 — see `PlanUsageWindow`.
  const percent = Math.round(window.utilization);
  return (
    <span
      className={cn('font-mono text-2xs', toneFor(window.utilization))}
      title={`${window.label}: ${String(percent)}% used`}
    >
      {String(percent)}%
    </span>
  );
}

function ServerAccountsSection({ profileId }: { readonly profileId: string }): ReactElement | null {
  const [listing, setListing] = useState<ServerAccountsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [busy, setBusy] = useState(false);
  /** The account a sign-in is open for, and what the server last said about it. */
  const [signingIn, setSigningIn] = useState<string | null>(null);
  /** The account whose name is being edited, and the draft. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** The endpoint account whose address and key are being edited. */
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  /** The account whose removal is awaiting the second click. */
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    const answer = await readServerAccounts(profileId as ProfileId);
    if ('error' in answer) {
      setError(answer.error);
      return;
    }
    setError(null);
    setListing(answer);
  };

  useEffect(() => {
    void refresh();
    // The profile is the server: repointing one at a different address is a
    // different set of accounts, not the same set moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const begin = async (accountId: string): Promise<void> => {
    setBusy(true);
    const started = await startServerSignIn(profileId as ProfileId, accountId);
    setBusy(false);
    if (started !== null) setSigningIn(accountId);
  };

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (label.trim().length === 0) return;
    setBusy(true);
    const created = await createServerAccount(profileId as ProfileId, label.trim(), provider);
    setBusy(false);
    if (created === null) return;
    setLabel('');
    setAdding(false);
    await refresh();
    if (provider === 'claude' || provider === 'codex') {
      // Straight into the login. Adding an account and not signing it in is a
      // half-finished job, and the server has just told us which id to drive.
      await begin(created.id);
    } else {
      // An endpoint account has no login to run — it authenticates with an
      // address and maybe a key, so the next step is the form for those.
      setAddressDraft('');
      setKeyDraft('');
      setConfiguring(created.id);
    }
  };

  const saveRename = async (accountId: string): Promise<void> => {
    if (renameDraft.trim().length === 0) return;
    setBusy(true);
    const updated = await updateServerAccount(profileId as ProfileId, accountId, {
      label: renameDraft.trim(),
    });
    setBusy(false);
    if (updated === null) return;
    setRenaming(null);
    await refresh();
    // A rename moves the account's route slug, and the model picker addresses
    // models as slug/model — re-read so it agrees with the server again.
    await refreshModels();
  };

  const saveEndpoint = async (accountId: string): Promise<void> => {
    setBusy(true);
    const updated = await updateServerAccount(profileId as ProfileId, accountId, {
      baseUrl: addressDraft.trim(),
      // Only sent when the user typed one: an untouched field must not clear
      // the stored key, which is exactly what the empty string would do.
      ...(keyDraft.length > 0 ? { apiKey: keyDraft } : {}),
    });
    setKeyDraft('');
    setBusy(false);
    if (updated === null) return;
    setConfiguring(null);
    await refresh();
    await refreshModels();
  };

  const remove = async (accountId: string): Promise<void> => {
    setBusy(true);
    const removed = await deleteServerAccount(profileId as ProfileId, accountId);
    setBusy(false);
    setRemoving(null);
    if (!removed) return;
    await refresh();
    await refreshModels();
  };

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-line pt-2">
      <div className="flex items-center gap-2">
        <span className="chrome-label text-ink-faint">Accounts on this server</span>
        {listing?.manageProfiles === true && signingIn === null && !adding ? (
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            onClick={() => setAdding(true)}
            disabled={busy}
          >
            <PlusIcon />
            Add account
          </Button>
        ) : null}
      </div>

      {/*
        A read that failed is not an empty server, and the two need different
        reactions: one means "check the address and the token", the other means
        "add an account". Only the first is worth an alert.
      */}
      {error !== null ? (
        <Alert variant="destructive" className="border-signal/40 bg-signal/5">
          <TriangleAlertIcon />
          <AlertDescription className="text-2xs text-signal">{error}</AlertDescription>
        </Alert>
      ) : listing === null ? (
        <p className="text-2xs text-ink-faint">Reading the server…</p>
      ) : listing.accounts.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-muted">
          This server serves no accounts yet. Until one is signed in it has no models to route to.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {listing.accounts.map((account) => {
            /*
              What the row offers is the provider's own vocabulary: a hosted
              account signs in, an endpoint account has an address and maybe a
              key. `kind` is the server's word for which one this is.
            */
            const endpoint = account.provider.kind !== 'hosted';
            const managed = listing.manageProfiles && signingIn === null;
            const auth = describeAccountAuth(account.auth);
            return (
              <li key={account.id} className="flex flex-col gap-1 text-2xs">
                <div className="flex items-center gap-2">
                  {renaming === account.id ? (
                    <form
                      className="flex flex-1 items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveRename(account.id);
                      }}
                    >
                      <Input
                        autoFocus
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        className="h-6 text-xs md:text-xs"
                        aria-label="New account name"
                      />
                      <Button size="xs" type="submit" disabled={busy || renameDraft.trim().length === 0}>
                        Rename
                      </Button>
                      <Button size="xs" variant="ghost" type="button" onClick={() => setRenaming(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="text-ink">{account.label}</span>
                      <span className="font-mono text-ink-faint">{account.provider.label}</span>
                      {/*
                        `live` says whether the *catalogue* was confirmed by the
                        account, which is all it ever said. It used to double as
                        the sign-in state too; `auth` answers that now, and the
                        two are drawn as the separate facts they are.
                      */}
                      <span className="font-mono text-ink-faint">
                        {account.live
                          ? `${String(account.models.length)} models`
                          : 'no models confirmed'}
                      </span>
                      <span className={cn('font-mono', auth.tone)} title={auth.detail}>
                        {auth.text}
                      </span>
                      <ServerAccountGauge profileId={profileId} accountId={account.id} />
                      {managed ? (
                        <span className="ml-auto flex items-center gap-1">
                          {endpoint ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => {
                                setAddressDraft(account.baseUrl ?? '');
                                setKeyDraft('');
                                setConfiguring(configuring === account.id ? null : account.id);
                              }}
                            >
                              Configure
                            </Button>
                          ) : (
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void begin(account.id)}
                            >
                              {account.auth?.loggedIn === true ? 'Sign in again' : 'Sign in'}
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                              setRenameDraft(account.label);
                              setRenaming(account.id);
                            }}
                          >
                            Rename
                          </Button>
                          {removing === account.id ? (
                            <>
                              <Button
                                size="xs"
                                variant="destructive"
                                disabled={busy}
                                onClick={() => void remove(account.id)}
                              >
                                Really remove
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => setRemoving(null)}
                              >
                                Keep
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setRemoving(account.id)}
                            >
                              Remove
                            </Button>
                          )}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
                {removing === account.id ? (
                  <p className="text-2xs leading-relaxed text-ink-muted">
                    Removes the account, its routes, and its stored key. Conversations it served and
                    its directory stay on the server.
                  </p>
                ) : null}
                {configuring === account.id ? (
                  <form
                    className="flex flex-col gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveEndpoint(account.id);
                    }}
                  >
                    <Input
                      autoFocus
                      value={addressDraft}
                      placeholder="Endpoint address, e.g. http://127.0.0.1:8080/v1"
                      onChange={(event) => setAddressDraft(event.target.value)}
                      className="h-6 text-xs md:text-xs"
                      aria-label="Endpoint address"
                    />
                    <Input
                      type="password"
                      value={keyDraft}
                      placeholder="API key — leave blank to keep the stored one"
                      onChange={(event) => setKeyDraft(event.target.value)}
                      className="h-6 text-xs md:text-xs"
                      aria-label="Endpoint API key"
                    />
                    <div className="flex items-center gap-2">
                      <Button size="xs" type="submit" disabled={busy}>
                        Save
                      </Button>
                      <Button size="xs" variant="ghost" type="button" onClick={() => setConfiguring(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {adding ? (
        <form className="flex items-center gap-2" onSubmit={(event) => void add(event)}>
          <Input
            autoFocus
            value={label}
            placeholder="Account name, e.g. work"
            onChange={(event) => setLabel(event.target.value)}
            className="h-7 text-xs md:text-xs"
            aria-label="Account name"
          />
          {/*
            The provider decides the next step: a CLI provider goes straight
            into its login, an endpoint provider into the address form. The
            native element rather than the styled select, deliberately — this
            is a five-option picker in a settings card, and the browser's own
            is the accessible baseline the styled one has to be taught.
          */}
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId)}
            className="h-7 rounded border border-line bg-transparent px-1 text-xs text-ink"
            aria-label="Provider"
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="llamacpp">llama.cpp</option>
            <option value="lmstudio">LM Studio</option>
            <option value="ollama">Ollama</option>
          </select>
          <Button size="xs" type="submit" disabled={busy || label.trim().length === 0}>
            {provider === 'claude' || provider === 'codex' ? 'Add & sign in' : 'Add & configure'}
          </Button>
          <Button size="xs" variant="ghost" type="button" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      ) : null}

      {signingIn !== null ? (
        <ServerSignIn
          profileId={profileId}
          accountId={signingIn}
          onDone={() => {
            setSigningIn(null);
            void refresh();
            // The catalogue this pane's profile offers is the server's, and it
            // just gained an account. Re-read it so the model picker agrees
            // with what this pane is showing.
            void refreshModels();
          }}
        />
      ) : null}

      {listing !== null && !listing.manageProfiles ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          This connection token may read the server&rsquo;s accounts but not change them. Mint one
          with <code className="font-mono">--manage-profiles</code> on the server to add accounts
          from here.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One sign-in, in progress on the server.
 *
 * Polls until the server says it is over. Every state the machine has is a
 * different sentence and a different affordance, because each asks the user for
 * something different — wait, open a link, paste a code, or nothing at all.
 */
function ServerSignIn({
  profileId,
  accountId,
  onDone,
}: {
  readonly profileId: string;
  readonly accountId: string;
  readonly onDone: () => void;
}): ReactElement {
  const [status, setStatus] = useState<ServerSignInStatus | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);

  const settled = status !== null && isSignInSettled(status.state);

  useEffect(() => {
    if (settled) return;
    let cancelled = false;
    const read = async (): Promise<void> => {
      const next = await readServerSignIn(profileId as ProfileId, accountId);
      if (!cancelled && next !== null) setStatus(next);
    };
    void read();
    const timer = setInterval(() => void read(), SIGN_IN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [profileId, accountId, settled]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (code.trim().length === 0) return;
    setSending(true);
    const next = await submitServerSignInCode(profileId as ProfileId, accountId, code.trim());
    setSending(false);
    // Cleared whether or not it was accepted. A code the server refused is
    // spent either way, and leaving it in the box invites the same paste again.
    setCode('');
    if (next !== null) setStatus(next);
  };

  if (status?.state === 'done') {
    return (
      <Alert className="border-sage/40 bg-sage/5">
        <CheckIcon />
        <AlertTitle className="text-2xs text-sage">Signed in on the server</AlertTitle>
        <AlertDescription className="flex items-center gap-2 font-mono text-2xs text-ink-muted">
          {[status.account?.email, status.account?.subscriptionType].filter(Boolean).join(' · ') ||
            'the account is in'}
          <Button size="xs" className="ml-auto" onClick={onDone}>
            Done
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (settled) {
    return (
      <Alert variant="destructive" className="border-signal/40 bg-signal/5">
        <TriangleAlertIcon />
        <AlertDescription className="flex items-center gap-2 text-2xs text-signal">
          <span className="min-w-0">
            {status?.error ?? `The sign-in ${status?.state ?? 'ended'}.`}
          </span>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={onDone}>
            Close
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-inset/60 px-3 py-2">
      <p className="text-2xs leading-relaxed text-ink-muted">
        The server is running the provider&rsquo;s login. Open the address below in your browser,
        sign in, and paste the code it gives you.
      </p>

      {status?.verificationUrl === undefined ? (
        <div className="flex items-center gap-2 text-2xs text-ink-faint">
          <Spinner className="size-3" />
          <span>Waiting for the server to publish the address…</span>
        </div>
      ) : (
        /*
          Verbatim, and as text. See the section comment: this string came from
          a subprocess on another machine and is about to be visited by a
          person, so nothing here shortens it, styles a friendlier name over it,
          or resolves it first.
        */
        <a
          href={status.verificationUrl}
          className="font-mono text-2xs break-all text-beam underline underline-offset-2"
        >
          {status.verificationUrl}
        </a>
      )}

      {status?.userCode === undefined ? null : (
        <p className="text-2xs text-ink-muted">
          The page should show this code:{' '}
          <span className="font-mono text-ink">{status.userCode}</span>
        </p>
      )}

      {/*
        A rejected code is a retry, not a failure — the CLI stays alive and asks
        again, which is what makes a half-copied code recoverable. Shown beside
        the box rather than as an alert, because the next action is right here.
      */}
      {status?.codeError === undefined ? null : (
        <p className="text-2xs text-amber">{status.codeError}</p>
      )}

      <form className="flex items-center gap-2" onSubmit={(event) => void submit(event)}>
        <Input
          value={code}
          spellCheck={false}
          autoComplete="off"
          placeholder="Paste the code here"
          onChange={(event) => setCode(event.target.value)}
          className="h-7 font-mono text-xs md:text-xs"
          aria-label="Sign-in code"
          disabled={status?.state === 'completing'}
        />
        <Button
          size="xs"
          type="submit"
          disabled={sending || code.trim().length === 0 || status?.state === 'completing'}
        >
          Submit
        </Button>
        <Button
          size="xs"
          variant="ghost"
          type="button"
          onClick={() => {
            void cancelServerSignIn(profileId as ProfileId, accountId);
            onDone();
          }}
        >
          Cancel
        </Button>
      </form>

      <div className="flex items-center gap-2 text-2xs text-ink-faint">
        <Spinner className="size-3" />
        <span>
          {status?.state === 'completing'
            ? 'Checking the code with the provider…'
            : 'This updates by itself.'}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

/** The value the "let the provider say" option carries. See {@link PlanField}. */
const PLAN_UNPINNED = 'auto';

/**
 * Which plan this account is on.
 *
 * ## Why the user is asked at all
 *
 * Everything else on this form is something only the user knows. This is the
 * one field that exists because the *provider* will not say: the usage payload
 * reports a plan family, so Claude answers `max` for both Max 5x and Max 20x
 * and Codex answers `pro` for both of its Pro tiers. The members of a family
 * differ by four times, which is more than enough to invert "which of my
 * accounts has the most room left" — the question the profile menu's
 * Recommended section answers.
 *
 * ## Why it defaults to unpinned rather than to a guess
 *
 * Left alone, Artemis assumes the smallest tier in the reported family. That
 * assumption can only ever *understate* an account, so the cost of never
 * touching this field is a recommendation not made, never a user sent to a
 * smaller account believing it is bigger. Pre-selecting a tier would be a
 * different kind of default: one that looks like an answer the app knows.
 *
 * ## Why it changes no behaviour beyond ranking
 *
 * A plan is not a setting — it is a fact about a subscription, and this field
 * cannot alter it. Pinning Max 20x on a Pro account buys nothing and breaks
 * nothing; it makes one menu sort wrongly until it is corrected. Worth saying
 * plainly in the description, because a field that names a paid tier invites
 * the reading that choosing it *selects* one.
 */
function PlanField({
  providerId,
  value,
  onChange,
}: {
  readonly providerId: ProviderId;
  readonly value: string;
  readonly onChange: (next: string) => void;
}): ReactElement | null {
  const plans = plansForProvider(providerId);
  // A provider Artemis has no plan table for. The whole field would be an empty
  // list, which asks a question it cannot take an answer to.
  if (plans.length === 0) return null;

  return (
    <Field>
      <FieldLabel htmlFor="profile-plan" className="chrome-label text-ink-faint">
        Plan
      </FieldLabel>
      <Select
        value={value === '' ? PLAN_UNPINNED : value}
        onValueChange={(next) => onChange(next === PLAN_UNPINNED ? '' : next)}
      >
        <SelectTrigger id="profile-plan" size="sm" className="w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PLAN_UNPINNED} className="text-xs">
            Let the provider say
          </SelectItem>
          {plans.map((plan) => (
            <SelectItem key={plan.id} value={plan.id} className="text-xs">
              {plan.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription className="text-2xs">
        Optional, and it changes nothing about what a run does. The provider reports which family a
        plan is in but not which tier — “max” covers both Max 5x and Max 20x — so naming the exact
        one is what lets the profile picker compare this account’s remaining capacity against your
        others. Left alone, Artemis assumes the smallest tier, which can only undersell it.
      </FieldDescription>
    </Field>
  );
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

/** One switch and the sentence explaining what turning it off does. */
function AvailabilityToggle({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (next: boolean) => void;
  readonly children: ReactElement | string;
}): ReactElement {
  return (
    <div className={cn('flex items-start gap-2.5', disabled && 'opacity-55')}>
      <Switch
        id={id}
        size="sm"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id} className="text-2xs font-medium text-ink">
          {label}
        </Label>
        <span className="text-2xs leading-relaxed text-ink-faint">{children}</span>
      </div>
    </div>
  );
}

/**
 * How much Artemis is allowed to use this account.
 *
 * ## Why two switches rather than one scale
 *
 * The two answers people actually give are different in kind, not in degree.
 * "Do not start sessions on this one, but leave it where I can reach it" is a
 * statement about *automation* — it is the client account, the one whose quota
 * is being saved, the one a colleague shares. "I am not using this at all" is a
 * statement about the *menu*. A single three-position control would make the
 * first a weaker form of the second, and then a user wanting the common case
 * would have to reason about the rare one to find it.
 *
 * ## Both switches read the same direction
 *
 * On means available, for both, with the consequence spelled out under each.
 * The temptation was to label the second one "Disabled" — that is how the
 * request is phrased and how the card badge reads — but a group where one
 * switch means "more" and the next means "less" is a group people flip the
 * wrong way. The word survives where it is a state being reported rather than a
 * control being set.
 *
 * ## Hiding the account settles the other question
 *
 * A hidden account is not one Artemis picks for you either — `disabled`
 * dominates in {@link isProfileAutoSelectable} — so the first switch goes inert
 * rather than staying live and implying otherwise. Its stored value is left
 * alone, so turning the account back on restores what the user had chosen
 * rather than resetting it.
 */
function AvailabilityField({
  autoSelect,
  enabled,
  onAutoSelectChange,
  onEnabledChange,
}: {
  readonly autoSelect: boolean;
  readonly enabled: boolean;
  readonly onAutoSelectChange: (next: boolean) => void;
  readonly onEnabledChange: (next: boolean) => void;
}): ReactElement {
  return (
    <Field>
      <FieldLabel className="chrome-label text-ink-faint">Availability</FieldLabel>
      <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-inset/60 px-3 py-2.5">
        <AvailabilityToggle
          id="profile-auto-select"
          label="Suggest automatically"
          checked={autoSelect && enabled}
          disabled={!enabled}
          onCheckedChange={onAutoSelectChange}
        >
          {enabled
            ? 'Let Artemis reach for this account on its own — the Recommended row in the profile picker, and the account a new session starts on. Off keeps it in the picker and out of the comparison, so it runs only when you pick it.'
            : 'Nothing suggests a hidden account. Turn the account back on below to choose this separately.'}
        </AvailabilityToggle>

        <AvailabilityToggle
          id="profile-enabled"
          label="Show in the profile picker"
          checked={enabled}
          onCheckedChange={onEnabledChange}
        >
          Off removes it from the picker entirely — the way to shelve an account without deleting
          its config directory, its login or its history. Sessions already recorded against it still
          resume into it.
        </AvailabilityToggle>
      </div>
    </Field>
  );
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Starting points for a profile that has no colour yet.
 *
 * Not a palette the user is confined to — the picker below is the OS's own and
 * reaches all sixteen million — just somewhere to begin that is not black.
 * Black is what an `<input type="color">` defaults to, and "pick a colour"
 * opening on the one colour nobody wants is a small hostility.
 *
 * Six hues, far enough apart to stay distinguishable at 8px, and picked by a
 * hash of the label so the same profile name always opens on the same colour.
 * Deterministic rather than random because a suggestion that changed every time
 * the form mounted would look like a bug.
 */
const COLOR_SUGGESTIONS: readonly string[] = [
  '#7c8cff',
  '#4fb286',
  '#e0913a',
  '#d2607a',
  '#3fa9c9',
  '#a071d8',
];

function suggestColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return COLOR_SUGGESTIONS[hash % COLOR_SUGGESTIONS.length] as string;
}

/**
 * Pick a colour, or none.
 *
 * Three states, because "no colour" is a real state and the ordinary one:
 *
 *  - **Unset** — a dashed button. Not a colour input showing some default,
 *    which would render a profile with no colour identically to a profile
 *    someone deliberately coloured periwinkle. Pressing it adopts a suggestion
 *    and moves to the state below, where the real picker is.
 *  - **Set** — the native `<input type="color">`, which is the OS's own picker
 *    and therefore full RGB (and an eyedropper, and whatever else the platform
 *    offers) for free, beside a hex field for anyone who has the value written
 *    down somewhere. Neither is a shortlist of swatches: the point of letting a
 *    user colour a profile is that *they* know which colour means "work".
 *  - **Cleared** — the × next to it, which is the only way back to unset and
 *    so is always present once a colour exists.
 *
 * The hex field holds the user's literal keystrokes, not the normalised value;
 * normalising on every change would rewrite `#7c8` to `#77cc88` under a cursor
 * that was two characters from finishing `#7c8cff`. It is normalised on submit
 * and on blur into the colour input, which are the two moments the value is
 * actually used.
 */
function ColorField({
  value,
  seed,
  onChange,
}: {
  readonly value: string;
  /** The profile's name, which the opening suggestion is derived from. */
  readonly seed: string;
  readonly onChange: (next: string) => void;
}): ReactElement {
  const normalized = normalizeProfileColor(value);

  if (normalized === null && value.trim().length === 0) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0 gap-1.5 border-dashed text-2xs text-ink-muted"
        onClick={() => onChange(suggestColor(seed))}
      >
        <PaletteIcon />
        Colour
      </Button>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {/*
        A bare `<input type="color">`, restyled. The browser draws it as an
        inset swatch with a border of its own; the pseudo-element rules strip
        that back to a plain square so it matches the swatch the sidebar
        renders. It falls back to the suggestion when the typed hex is not yet
        valid, because this element cannot display an invalid value — it would
        silently show black and look like it had eaten the input.
      */}
      <input
        type="color"
        aria-label="Profile colour"
        value={normalized ?? suggestColor(seed)}
        onChange={(event) => onChange(event.target.value)}
        className="size-8 shrink-0 cursor-pointer appearance-none rounded-md border border-hairline bg-transparent p-0.5 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <Input
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-label="Profile colour, as hex"
        aria-invalid={normalized === null}
        placeholder="#7c8cff"
        onChange={(event) => onChange(event.target.value)}
        className="w-24 shrink-0 font-mono text-xs md:text-xs"
      />
      <IconButton
        label="Remove the colour"
        size="icon-xs"
        className="shrink-0 text-ink-faint"
        onClick={() => onChange('')}
      >
        <XIcon />
      </IconButton>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Form                                                                       */
/* -------------------------------------------------------------------------- */

interface FormProps {
  /** Receives the profile id, so the caller can move on to signing it in. */
  readonly onDone: (profileId: string) => void;
  readonly onCancel: () => void;
  readonly profile?: ProfileMetadata;
}

/**
 * What an empty tool-servers box suggests.
 *
 * One http server, because that is the shape a user is most likely to have an
 * address for and the one that needs no binary installed. The full set of
 * examples — GitHub, Forgejo, OpenBao, a cortex wrapper — is in
 * `docs/LOCAL-MODEL-TOOLS.md`, which is where a placeholder cannot go.
 */
const TOOL_SERVERS_PLACEHOLDER = `[
  {
    "name": "forgejo",
    "transport": "http",
    "url": "https://git.example/api/v1/mcp",
    "headers": { "Authorization": "Bearer \${FORGEJO_TOKEN}" }
  }
]`;

function ProfileForm({ profile, onDone, onCancel }: FormProps): ReactElement {
  const fallbackProvider = usePane((s) => s.activeProviderId);
  const providers = useApp((s) => s.providers);
  const platform = useApp((s) => s.platform);

  /**
   * Which CLI the new profile belongs to.
   *
   * Seeded from the active provider, which is what this form used to assume
   * outright — and that assumption was the only thing standing between a user
   * and a second provider's account. A profile is created from *this* screen,
   * the app is pointed at Claude, so every profile it could make was a Claude
   * one; the Codex adapter was wired, the CLI was installed, and there was still
   * no way to sign in to it without first knowing to change an unrelated setting
   * in the command palette.
   *
   * Create-only. An existing profile's provider is not editable, because the
   * config directory below belongs to that provider's CLI — changing one without
   * the other would point `codex login` at a directory full of Claude's session
   * history.
   */
  const [chosenProvider, setChosenProvider] = useState<ProviderId>(fallbackProvider);

  const [label, setLabel] = useState(profile?.label ?? '');
  const [configDir, setConfigDir] = useState(profile?.configDir ?? '');
  const [color, setColor] = useState(profile?.color ?? '');
  const [planId, setPlanId] = useState(profile?.planId ?? '');
  /*
   * Seeded from the profile, which is the whole point of the field being on
   * `ProfileMetadata` at all: the address used to live in `publicEnv`, which
   * the renderer may not read, so it could be typed once and never seen again
   * — not to confirm it, not to correct a typo in it.
   */
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '');
  /*
   * Two pieces of state for one secret, because "a key is stored" and "the
   * user typed a new one" are different facts and the editor needs both. The
   * stored key itself is never here — the renderer is told a boolean and no
   * more — so an untouched field must mean "leave it alone" rather than
   * "clear it", which is exactly what `undefined` means to the patch.
   */
  const [apiKey, setApiKey] = useState('');
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  /*
    Held as the *positive* of what is stored, which is what lets both switches
    read "on means available". Absent is the ordinary state for each — see
    `Profile.autoSelect` — so the seeds are the two comparisons that make an
    unset field mean yes.
  */
  const [autoSelect, setAutoSelect] = useState(profile?.autoSelect !== false);
  const [enabled, setEnabled] = useState(profile?.disabled !== true);
  const [envText, setEnvText] = useState('');
  /*
   * The tool servers, edited as the JSON they are stored as.
   *
   * A text box rather than a row-per-server builder, and that is a deliberate
   * first cut. What a server needs is different per transport — a command and
   * arguments, or a URL and headers — so a form would be three forms, and the
   * thing a user most often does with one of these is paste it from a README.
   * The parse and the protocol's own validator run on every save and put the
   * sentence under the field, which is the part that actually has to be right.
   */
  const [toolServersText, setToolServersText] = useState(
    profile?.toolServers === undefined ? '' : `${JSON.stringify(profile.toolServers, null, 2)}
`,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editing = profile !== undefined;
  const providerId: ProviderId = profile?.providerId ?? chosenProvider;
  const native = hasNativeDirectoryPicker();
  const providerLabel = useApp(
    (s) => s.providers.find((p) => p.id === providerId)?.label ?? providerId,
  );
  const homeDirName = CONVENTIONAL_CONFIG_DIR[providerId];
  const activeKind = useApp(
    (s) => s.providers.find((p) => p.id === providerId)?.kind ?? 'hosted',
  );
  /**
   * Why the chosen provider's server is not answering, if it is not.
   *
   * Only meaningful for a local provider, and only as a note: see the picker
   * below for why an unreachable local server does not stop a profile being
   * made. `undefined` when the server answered, which is the ordinary case.
   */
  const chosenUnavailableReason = useApp((s) => {
    const chosen = s.providers.find((p) => p.id === providerId);
    return chosen?.available === false ? chosen.unavailableReason : undefined;
  });

  /**
   * Whether the user has taken ownership of the path.
   *
   * Until they do, the suggestion tracks the label they are typing, so
   * "Work" becomes `…/profiles/work` without anyone having to ask for it. The
   * moment they edit or browse, the suggestion stops moving underneath them —
   * a field that rewrites itself while you are looking at it is worse than one
   * that starts out blank.
   */
  const touched = useRef(editing);

  useEffect(() => {
    if (touched.current) return;
    let cancelled = false;
    void suggestConfigDir(label).then((suggestion) => {
      if (!cancelled && !touched.current && suggestion) setConfigDir(suggestion);
    });
    return () => {
      cancelled = true;
    };
  }, [label]);

  // The same rule the IPC boundary and the profile store apply, applied while
  // the user is still typing, so a path is never accepted here and refused
  // three layers down.
  const pathProblem = configDir.trim().length === 0 ? null : configDirProblem(configDir);

  const browse = async (): Promise<void> => {
    const choice = await pickDirectory(configDir);
    if (choice.status === 'chosen') {
      touched.current = true;
      setConfigDir(choice.path);
      setError(null);
      return;
    }
    // Cancelling is a decision, not a failure. Say nothing.
    if (choice.status === 'cancelled') return;
    setError(choice.message);
  };

  function parseEnv(): Record<string, string> | string {
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return `Cannot parse “${trimmed}”. Use NAME=value, one per line.`;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  }

  /**
   * The tool servers the box describes, or the sentence to show instead.
   *
   * The same {@link toolServersProblem} the IPC boundary and the profile store
   * run, run here first — this is the only one of the three that can put the
   * message beside the text the user is still looking at.
   */
  function parseToolServers(): readonly ToolServerConfig[] | string {
    const text = toolServersText.trim();
    if (text === '') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return `Tool servers must be a JSON array. ${cause instanceof Error ? cause.message : ''}`.trim();
    }
    if (!Array.isArray(parsed)) return 'Tool servers must be a JSON array, even for a single server.';
    const servers = parsed as ToolServerConfig[];
    const problem = toolServersProblem(servers);
    return problem === null ? servers : problem;
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (label.trim().length === 0) {
      setError('Give the profile a name.');
      return;
    }

    const problem = configDirProblem(configDir);
    if (problem !== null) {
      setError(problem);
      return;
    }

    // Refused rather than dropped. The store would discard an unparseable
    // colour and save the rest, which would look to the user like the form had
    // simply ignored a field they filled in.
    const colorTrouble = profileColorProblem(color);
    if (colorTrouble !== null) {
      setError(colorTrouble);
      return;
    }

    // Checked here as well as at the IPC boundary and in the store: this is
    // the one of the three that can put the message under the field while the
    // user is still looking at what they typed.
    const addressTrouble = baseUrl.trim() === '' ? null : baseUrlProblem(baseUrl);
    if (addressTrouble !== null) {
      setError(addressTrouble);
      return;
    }

    const env = parseEnv();
    if (typeof env === 'string') {
      setError(env);
      return;
    }

    const toolServers = parseToolServers();
    if (typeof toolServers === 'string') {
      setError(toolServers);
      return;
    }

    setBusy(true);
    if (profile) {
      const ok = await updateProfile(profile.id, {
        label: label.trim(),
        configDir: configDir.trim(),
        // Always sent, empty string included: that is how a patch says "remove
        // the colour", and omitting it when the user cleared the swatch would
        // silently keep the old one. See `ProfilePatch.color`.
        color: normalizeProfileColor(color) ?? '',
        // Always sent, empty string included, for the same reason as the
        // colour: that is how a patch says "stop pinning a plan".
        planId: normalizeProfilePlanId(planId, providerId) ?? '',
        // Always sent, both values included: a boolean with a default has no
        // "absent" for the form to send, and omitting the one the user just
        // switched off would save every other field and quietly drop that one.
        // The store collapses the default back to absent on the way to disk.
        autoSelect,
        disabled: !enabled,
        // Always sent, empty string included — the same reason as the colour
        // and the plan above: that is how a patch says "back to the provider's
        // default", and this field, unlike `publicEnv` below, is one the
        // editor can actually see and therefore may safely overwrite.
        baseUrl: baseUrl.trim(),
        // Sent only when the user typed in the field. An untouched key box
        // means "leave the stored key alone", which is the only thing it can
        // honestly mean: the renderer is never told what that key is, so it
        // has nothing to send back.
        ...(apiKeyTouched ? { apiKey } : {}),
        ...(Object.keys(env).length > 0 ? { publicEnv: env } : {}),
        // Always sent, the empty array included: the box holds the whole list,
        // so an emptied box means "no tool servers" and omitting it would keep
        // the ones the user just deleted. See `ProfilePatch.toolServers`.
        ...(activeKind === 'local' ? { toolServers } : {}),
      });
      setBusy(false);
      if (ok) onDone(profile.id);
      return;
    }

    const created = await createProfile({
      label: label.trim(),
      providerId,
      configDir: configDir.trim(),
      ...(normalizeProfileColor(color) === null ? {} : { color }),
      ...(normalizeProfilePlanId(planId, providerId) === null ? {} : { planId }),
      ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
      ...(apiKey === '' ? {} : { apiKey }),
      ...(Object.keys(env).length > 0 ? { publicEnv: env } : {}),
    });
    setBusy(false);
    // The created id comes back from `createProfile` itself. It cannot be read
    // off the focused pane: when that pane holds a conversation, the store
    // deliberately leaves the old profile active — and the sign-in step below
    // must poll the profile that was just created, not whichever one the pane
    // kept.
    if (created) onDone(created);
  }

  return (
    <Card size="sm" className="rounded-lg border-hairline bg-wash-strong">
      <CardContent>
        <form onSubmit={(event) => void submit(event)}>
          <FieldGroup className="gap-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-ink">
                {editing ? 'Edit profile' : 'New profile'}
              </h2>
              {profile ? <ToneBadge>{profile.id.slice(0, 8)}</ToneBadge> : null}
            </div>

            {/*
              Create only, and first: it decides what every field under it means.
              An unavailable provider is offered and explained rather than
              dropped — "the Codex CLI is not on your PATH" is a thing the user
              can act on, and a missing row is not.
            */}
            {editing ? null : (
              <Field>
                <FieldLabel className="chrome-label text-ink-faint">Provider</FieldLabel>
                {/*
                  Split by `ProviderKind` rather than by a list kept here, so a
                  new provider lands in the right half without this file being
                  edited. The two halves are entered differently, which is the
                  reason they are separated at all: a hosted profile is an
                  account and a config directory, a local one is an address.
                */}
                {PROVIDER_GROUPS.map((group) => {
                  const options = providers.filter(
                    (option) => (option.kind ?? 'hosted') === group.kind,
                  );
                  if (options.length === 0) return null;
                  return (
                    <div key={group.kind} className="flex flex-col gap-1">
                      <span className="text-2xs text-ink-faint">{group.heading}</span>
                      <ButtonGroup>
                        {options.map((option) => (
                          <ReasonButton
                            key={option.id}
                            type="button"
                            size="sm"
                            variant={option.id === providerId ? 'secondary' : 'outline'}
                            aria-pressed={option.id === providerId}
                            /*
                             * A hosted provider that is not installed cannot
                             * have a profile: there is a CLI to install and an
                             * account to sign into, and neither can be done
                             * from here. Disabling it and saying why is the
                             * honest answer.
                             *
                             * A local one is the opposite. Its profile *is* an
                             * address — nothing to install, nothing to sign
                             * into — so whether the server happens to be
                             * running is a fact about this second, not about
                             * whether the profile can exist. Disabling it made
                             * a dead end out of the ordinary case: the probe
                             * only ever asks the *default* port, so anyone
                             * running LM Studio on another port, or on the
                             * machine next to them, could never reach the field
                             * where they would say so. You had to already be
                             * reachable at the address you were trying to
                             * change.
                             *
                             * So local stays selectable and the probe's answer
                             * becomes the hint under the group.
                             */
                            disabled={group.kind !== 'local' && !option.available}
                            disabledReason={option.unavailableReason}
                            onClick={() => setChosenProvider(option.id)}
                          >
                            {option.label}
                          </ReasonButton>
                        ))}
                      </ButtonGroup>
                    </div>
                  );
                })}
                <FieldDescription className="text-2xs">
                  {providerId === 'artemis'
                    ? 'Another Artemis, serving. Turns run on that machine, in the workspace its connection token pins — not in the directory this pane shows — and permission prompts are answered there by nobody, so they are refused. What streams back is the reply.'
                    : activeKind === 'local'
                      ? 'Which server on this machine this profile talks to. There is nothing to sign in to — the profile is an address, and the server either answers or it does not.'
                      : "Which CLI this account belongs to. It cannot be changed afterwards — the config directory below is that CLI's, and its own sign-in is what writes into it."}
                </FieldDescription>
                {/*
                  Reported rather than enforced. The profile is worth creating
                  either way — you may be about to start the server, or to point
                  it somewhere other than the port this was probed on — so this
                  says what was found and leaves the decision alone.
                */}
                {activeKind === 'local' && chosenUnavailableReason !== undefined ? (
                  <FieldDescription className="text-2xs text-amber">
                    {chosenUnavailableReason} You can still create the profile — it is an address,
                    not an installation.
                  </FieldDescription>
                ) : null}
              </Field>
            )}

            <Field>
              <FieldLabel htmlFor="profile-label" className="chrome-label text-ink-faint">
                Name
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="profile-label"
                  value={label}
                  placeholder="Work"
                  autoComplete="off"
                  autoFocus={!editing}
                  onChange={(event) => setLabel(event.target.value)}
                  className="min-w-0 flex-1 text-xs md:text-xs"
                />
                <ColorField value={color} seed={label} onChange={setColor} />
              </div>
              <FieldDescription className="text-2xs">
                The colour is optional. Give one and it appears as a small square wherever this
                profile is named — the session list, the profile picker — which is how you tell at a
                glance which account the next prompt will bill.
              </FieldDescription>
            </Field>

            <PlanField providerId={providerId} value={planId} onChange={setPlanId} />

            <Field>
              <FieldLabel htmlFor="profile-config-dir" className="chrome-label text-ink-faint">
                Config directory
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="profile-config-dir"
                  value={configDir}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={pathProblem !== null}
                  placeholder={
                    platform === 'win32'
                      ? `C:\\Users\\you\\${homeDirName}`
                      : `/Users/you/${homeDirName}`
                  }
                  onChange={(event) => {
                    touched.current = true;
                    setConfigDir(event.target.value);
                    setError(null);
                  }}
                  className="min-w-0 flex-1 font-mono text-xs md:text-xs"
                />
                <ReasonButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void browse()}
                  disabled={!native}
                  disabledReason={native ? undefined : NO_PICKER_REASON}
                  tooltip="Open your system's folder chooser."
                >
                  <FolderSearchIcon />
                  Choose…
                </ReasonButton>
              </div>
              <FieldDescription className="text-2xs">
                {providerLabel} keeps this profile’s login and its session history here. Artemis
                suggests a fresh directory; point it at an existing one — your own{' '}
                <code className="font-mono">~/{homeDirName}</code>, say — to reuse an account you
                are already signed in to.
              </FieldDescription>
              {pathProblem ? (
                <FieldDescription className="text-2xs text-amber">{pathProblem}</FieldDescription>
              ) : null}
            </Field>

            {/*
              Edit only, on the same rule as the environment box below: a
              profile being created is a profile about to be signed in to and
              worked in, so both switches would be asking, at the least useful
              moment, about a state nobody has reached yet. `ProfileDraft`
              carries the fields regardless — the shape should not depend on
              which form happens to be on screen — so a profile can be created
              shelved by a caller that means it.
            */}
            {editing ? (
              <AvailabilityField
                autoSelect={autoSelect}
                enabled={enabled}
                onAutoSelectChange={setAutoSelect}
                onEnabledChange={setEnabled}
              />
            ) : null}

            {/*
              The two fields a server-backed profile is actually made of.

              Shown on the create path as well as the edit one, unlike the
              environment box below: for a local provider this *is* the
              profile — a hosted account is identified by a directory it has
              signed into, and one of these is identified by an address. A
              user whose server is not on the default port cannot make a
              working profile without it, which is the definition of a field
              that belongs on the first screen.
            */}
            {activeKind === 'local' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="profile-base-url" className="chrome-label text-ink-faint">
                    Server address
                  </FieldLabel>
                  <Input
                    id="profile-base-url"
                    value={baseUrl}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={defaultBaseUrlFor(providerId)}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    className="font-mono text-xs md:text-xs"
                  />
                  <FieldDescription className="text-2xs">
                    Where {providerLabel} is listening. Include http:// or https://. Leave it
                    empty for {defaultBaseUrlFor(providerId)}. Another machine, a tunnel or a
                    reverse proxy all work — this is the address, not the machine.
                    {providerId === 'artemis'
                      ? ' An Artemis server answers only its own loopback, so another machine is reached through whatever forwards to it — a Tailscale serve, an SSH tunnel — not by the server opening a port.'
                      : null}
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="profile-api-key" className="chrome-label text-ink-faint">
                    {providerId === 'artemis' ? 'API key — a connection token' : 'API key (optional)'}
                  </FieldLabel>
                  <Input
                    id="profile-api-key"
                    type="password"
                    value={apiKey}
                    spellCheck={false}
                    autoComplete="off"
                    /*
                      The placeholder carries the only thing the renderer knows
                      about a stored key: that there is one. It cannot show the
                      value — nothing sends it back — so an empty box with no
                      hint would read as "no key set" to someone who set one.
                    */
                    placeholder={
                      profile?.hasApiKey === true && !apiKeyTouched
                        ? 'A key is stored — type to replace it'
                        : providerId === 'artemis'
                          ? 'Paste a connection token from the server'
                          : 'Only if your server needs one'
                    }
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setApiKeyTouched(true);
                    }}
                    className="font-mono text-xs md:text-xs"
                  />
                  <FieldDescription className="text-2xs">
                    {providerId === 'artemis' ? (
                      <>
                        One of the serving Artemis&rsquo;s connection tokens — it refuses every
                        request without one. Stored encrypted by the operating system, never shown
                        again, and sent only to the address above.
                      </>
                    ) : (
                      <>
                        For a server started with <span className="font-mono">--api-key</span>, or
                        behind something that authenticates. Stored encrypted by the operating
                        system, never shown again, and sent only to the address above.
                      </>
                    )}
                    {profile?.hasApiKey === true ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="underline underline-offset-2 hover:text-ink"
                          onClick={() => {
                            setApiKey('');
                            setApiKeyTouched(true);
                          }}
                        >
                          Remove the stored key
                        </button>
                        {apiKeyTouched && apiKey === '' ? ' — it goes when you save.' : '.'}
                      </>
                    ) : null}
                  </FieldDescription>
                </Field>
              </>
            ) : null}

            {/*
              Edit only. Creating a profile is meant to be two fields and a
              button; an "extra environment" box on that path is a question
              nobody creating their first profile can answer, and it is
              reachable a click later for the people who do want it.
            */}
            {editing ? (
              <Field>
                <FieldLabel htmlFor="profile-env" className="chrome-label text-ink-faint">
                  Extra environment (optional)
                </FieldLabel>
                <Textarea
                  id="profile-env"
                  rows={2}
                  value={envText}
                  spellCheck={false}
                  placeholder="ANTHROPIC_MODEL=claude-sonnet-5"
                  onChange={(event) => setEnvText(event.target.value)}
                  className="min-h-14 font-mono text-xs md:text-xs"
                />
                <FieldDescription className="text-2xs">
                  NAME=value per line. Credential-shaped names, and anything that decides where a
                  credential is sent, are rejected.
                </FieldDescription>
              </Field>
            ) : null}

            {/*
              Local providers only, and edit only.

              Only the local adapter has a tool-server client of its own — the
              hosted providers reach MCP through the runtime Artemis wraps, and
              offering the field for them would be a box that changes nothing.
              Edit-only for the same reason the environment box above is: a new
              profile is two fields and a button.
            */}
            {editing && activeKind === 'local' ? (
              <Field>
                <FieldLabel htmlFor="profile-tool-servers" className="chrome-label text-ink-faint">
                  Tool servers (optional)
                </FieldLabel>
                <Textarea
                  id="profile-tool-servers"
                  rows={4}
                  value={toolServersText}
                  spellCheck={false}
                  placeholder={TOOL_SERVERS_PLACEHOLDER}
                  onChange={(event) => setToolServersText(event.target.value)}
                  className="min-h-24 font-mono text-xs md:text-xs"
                />
                <FieldDescription className="text-2xs">
                  A JSON array of MCP servers this profile’s runs may call, reached as
                  <code className="px-1">mcp__name__tool</code>. Write a{' '}
                  <code className="px-1">{'${NAME}'}</code> reference for a token and export it — a
                  value that looks like a credential is refused, because this file is not encrypted.
                </FieldDescription>
              </Field>
            ) : null}

            {error ? (
              <Alert variant="destructive" className="border-signal/40 bg-signal/5">
                <TriangleAlertIcon />
                <AlertDescription className="font-mono text-2xs text-signal">
                  {error}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy}>
                {editing ? 'Save changes' : 'Create and sign in'}
              </Button>
              <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              {editing ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto text-signal"
                  disabled={busy}
                  onClick={() => void signOutProfile(profile.id)}
                >
                  Sign out
                </Button>
              ) : null}
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
