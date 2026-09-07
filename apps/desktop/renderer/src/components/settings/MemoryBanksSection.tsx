/**
 * Memory banks — Cerebro generalized, as the instance half of Instructions.
 * ============================================================================
 *
 * No longer a pane of its own: `InstructionsSection` composes these groups
 * under the prompt library, because a bank is one instance of the rule the
 * prompts state — what the agent is told before the conversation starts. The
 * file keeps its name for the same reason `AgentsSection.tsx` keeps its own:
 * the section id `cerebro` is a frozen address that resolves here, and the
 * file is easier to find when it is named after what the address meant.
 *
 * The banks run themselves: a sync at every run start, agents drafting into
 * them, pull requests reviewing them. So the surface exists for the two moments
 * automation cannot cover. Onboarding — joining, creating, or adopting a bank
 * — and *inspection*, when a person wants to read what agents have been
 * remembering, prune what no longer holds, and decide which banks this
 * machine carries. Everything else here is deliberately a window, not a
 * control surface.
 *
 * ---------------------------------------------------------------------------
 * ADDING A MEMORY IS NOT A PANE ACTION
 * ---------------------------------------------------------------------------
 *
 * There used to be a draft form here, and it was removed on purpose (Seth,
 * 2026-08-17): memories enter a bank through agents, who are prompted to
 * write them in house style — scoped to their repos, description as a
 * retrieval hook, absolute dates — and to route team facts there rather than
 * to personal memory. A human-facing form was a second authoring path that
 * knew none of that. The human way to add a fact is to state it to an agent,
 * which is also the cheaper way. What remains human is *pruning*: `retire`
 * stays, because deciding a fact no longer holds is exactly the judgment the
 * inspection moment exists for. It runs through the bank's own gates and
 * answers with a receipt (the CLI's own words) rather than optimistically
 * mutating the list.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF SWITCH, AND WHY BOTH ARE BUTTONS
 * ---------------------------------------------------------------------------
 *
 * Each bank has a wiring switch (the CLI's, honoured by stock Claude Code's
 * hook too) and Artemis has one master gate (prompt + run-start syncs). Both
 * render as buttons, not `Switch`es: the per-bank one spawns `enable`/
 * `disable` and a sync, takes seconds and can fail, and a toggle that
 * animates to a position it then has to animate back from is lying twice.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type {
  MemoryBankAuthInput,
  MemoryBankInfo,
  MemoryBankMemory,
  MemoryBankRole,
  MemoryBankVerifyRemoteResponse,
  SecretConnectionState,
  SecretField,
  SecretRef,
  SecretRefTestResult,
} from '@rx-artemis/protocol';
import { secretRefProblem } from '@rx-artemis/protocol';

import type { MemoryBanksPane } from '../../hooks/useMemoryBanks';
import { useSecretManagers } from '../../hooks/useSecretManagers';
import { CodeBlock, Fold, Row, StatusDot, ToneBadge } from '../primitives';
import { SettingsGroup } from './pane';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * The whole-library sync, for the Instructions pane's title row.
 *
 * Rendered only when there is something to sync and the master gate is up —
 * the same condition the old pane's `actions` slot used — because a sync
 * button over a machine with no wired banks is a promise about nothing.
 */
export function SyncAllButton({ pane }: { readonly pane: MemoryBanksPane }): ReactElement | null {
  const hasBanks = (pane.status?.banks.length ?? 0) > 0;
  if (pane.status === null || !pane.status.masterEnabled || !hasBanks) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pane.busy !== null || pane.reading}
      onClick={() => pane.sync()}
    >
      {pane.busy === 'sync' ? 'Syncing…' : 'Sync all'}
    </Button>
  );
}

export function MemoryBankGroups({ pane }: { readonly pane: MemoryBanksPane }): ReactElement {
  const hasBanks = (pane.status?.banks.length ?? 0) > 0;

  return (
    <>
      {pane.error !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{pane.error}</p>
      ) : null}

      {pane.reading && pane.status === null ? (
        <p className="text-2xs leading-relaxed text-ink-faint">Reading the banks…</p>
      ) : null}

      {pane.status !== null && hasBanks ? <MasterGroup pane={pane} /> : null}
      {pane.status !== null && hasBanks ? <BanksGroup pane={pane} /> : null}
      {pane.status !== null ? <AddGroup pane={pane} first={!hasBanks} /> : null}

      {pane.lastAction !== null ? (
        <CodeBlock
          text={pane.lastAction.message}
          tone={pane.lastAction.ok ? 'neutral' : 'error'}
          className="max-h-32"
        />
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The master gate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Artemis's own switch, narrower than each bank's: it decides whether runs
 * are briefed about the banks and whether Artemis syncs them at run start.
 * Off is the default — banks being configured is not consent to spending
 * every run's context on them.
 */
function MasterGroup({ pane }: { readonly pane: MemoryBanksPane }): ReactElement {
  const on = pane.status?.masterEnabled === true;
  const working = pane.busy === 'master';

  return (
    <SettingsGroup label={on ? 'On for Artemis' : 'Off for Artemis'}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <StatusDot tone={on ? 'mint' : 'amber'} />
        <p className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-muted">
          {on
            ? 'Every run syncs the enabled banks before it starts, and agents are told to consult them and record what they learn. The per-bank switches below decide which banks take part.'
            : 'Artemis is not using the banks: no run-start syncs, and agents are not briefed. The machine wiring (hooks and profile blocks for stock Claude Code) stays as the per-bank switches left it.'}
        </p>
        <Button
          size="sm"
          variant={on ? 'outline' : 'default'}
          disabled={pane.busy !== null || pane.reading}
          onClick={() => pane.setMasterEnabled(!on)}
        >
          {working ? (on ? 'Turning off…' : 'Turning on…') : on ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* The banks                                                                  */
/* -------------------------------------------------------------------------- */

function BanksGroup({ pane }: { readonly pane: MemoryBanksPane }): ReactElement {
  const banks = pane.status?.banks ?? [];
  return (
    <SettingsGroup label={`Banks (${banks.length})`}>
      <div className="flex flex-col divide-y divide-hairline">
        {banks.map((bank) => (
          <BankCard key={bank.slug} bank={bank} pane={pane} />
        ))}
      </div>
    </SettingsGroup>
  );
}

function BankCard({
  bank,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  const working = pane.busy === 'switch';
  // Controlled, because `Fold` routes `onOpenChange` only in controlled mode —
  // and opening is when the bank's memories are actually worth a CLI spawn.
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const profiles = pane.status?.profiles ?? [];
  const wired = profiles.filter((profile) => profile.banks[bank.slug] === true).length;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <StatusDot tone={bank.enabled && bank.exists ? 'mint' : 'amber'} />
        <span className="font-mono text-xs font-medium text-ink">{bank.slug}</span>
        <ToneBadge tone="neutral">{bank.role === 'readonly' ? 'read-only' : 'read-write'}</ToneBadge>
        {bank.isDefault ? <ToneBadge tone="neutral">default</ToneBadge> : null}
        {!bank.exists ? <ToneBadge tone="signal">missing on disk</ToneBadge> : null}
        {/*
          Worth its own badge because it is the fact this feature exists to
          produce: a bank marked this way keeps no secret on this machine at
          all. And when its reference stops resolving the badge turns, because
          a bank that has quietly stopped syncing is exactly the thing a person
          opens this pane to find out about.
        */}
        {bank.credential?.kind === 'ref' ? (
          <ToneBadge tone={bank.credential.problem === undefined ? 'cyan' : 'signal'}>
            {bank.credential.problem === undefined ? 'key manager' : 'key manager unreachable'}
          </ToneBadge>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          {bank.enabled ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-2xs"
              disabled={pane.busy !== null}
              onClick={() => pane.sync(bank.slug)}
            >
              {pane.busy === 'sync' ? 'Syncing…' : 'Sync'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={bank.enabled ? 'ghost' : 'default'}
            className="text-2xs"
            disabled={pane.busy !== null}
            onClick={() => pane.setEnabled(bank.slug, !bank.enabled)}
          >
            {working ? '…' : bank.enabled ? 'Turn off' : 'Turn on'}
          </Button>
          <ForgetButton bank={bank} pane={pane} />
        </span>
      </div>
      <Row label="Repo">{bank.path}</Row>
      <Row label="Remote">{bank.remote ?? 'none — changes commit locally'}</Row>
      <Row label="Bank">
        {`${bank.memories} memories${bank.mirrored > 0 ? ` (${bank.mirrored} mirrored, read-only)` : ''} · ${bank.validationErrors} validation errors · installed in ${bank.projects} projects`}
      </Row>
      {/*
        The registry flag and the on-disk wiring are two different facts, and
        they have disagreed in the wild: a bank can be "on" while no profile
        carries its block (the setup flow records the flag; `enable` does the
        wiring, and an enable that failed leaves exactly this state). Saying so
        — with the repair right there — is what turns a silent nothing into a
        one-click fix.
      */}
      {bank.enabled && bank.exists && profiles.length > 0 && wired === 0 ? (
        <div className="flex items-center gap-2">
          <p className="text-2xs leading-relaxed text-amber">
            On, but no profile carries its block — the wiring step never completed on this machine.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="text-2xs"
            disabled={pane.busy !== null}
            onClick={() => pane.setEnabled(bank.slug, true)}
          >
            {working ? 'Wiring…' : 'Wire profiles'}
          </Button>
        </div>
      ) : null}
      {/*
        A reference that stopped resolving degrades this one bank and says so
        on its own row: no dialog, no retry loop, no stale fallback. The
        resolver runs inside the sync that starts every run, and a vault being
        sealed is not a reason a run fails to start.
      */}
      {bank.credential?.problem !== undefined ? (
        <p className="text-2xs leading-relaxed text-signal">
          Its token could not be fetched, so this bank is not syncing: {bank.credential.problem}
        </p>
      ) : null}
      <Fold
        summary={<span className="text-2xs">memories</span>}
        open={memoriesOpen}
        onOpenChange={(open) => {
          setMemoriesOpen(open);
          if (open) pane.loadMemories(bank.slug);
        }}
      >
        <BankMemories bank={bank} pane={pane} />
      </Fold>
    </div>
  );
}

function BankMemories({
  bank,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  const [query, setQuery] = useState('');
  const loaded = pane.memories[bank.slug];

  const visible = useMemo(() => {
    const all = loaded ?? [];
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter(
      (memory) =>
        memory.name.toLowerCase().includes(needle) ||
        memory.description.toLowerCase().includes(needle) ||
        (memory.org ?? '').toLowerCase().includes(needle) ||
        (memory.project ?? '').toLowerCase().includes(needle) ||
        memory.body.toLowerCase().includes(needle),
    );
  }, [loaded, query]);

  /**
   * Org → project buckets, in the CLI's own order (it sorts by org, project,
   * name, so insertion order is already the display order). A flat classic
   * bank renders without headers at all — one bucket named nothing would be a
   * header saying nothing.
   */
  const groups = useMemo(() => {
    const buckets = new Map<
      string,
      { readonly org: string | null; readonly project: string | null; readonly items: MemoryBankMemory[] }
    >();
    for (const memory of visible) {
      // A separator no path segment can contain, written as an escape rather
      // than as the byte itself so this file stays text to grep and to diff.
      const key = `${memory.org ?? ''}\x00${memory.project ?? ''}`;
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, { org: memory.org, project: memory.project, items: [memory] });
      } else {
        bucket.items.push(memory);
      }
    }
    return [...buckets.values()];
  }, [visible]);
  const flat =
    groups.length <= 1 && (groups[0]?.org ?? null) === null && (groups[0]?.project ?? null) === null;

  if (loaded === undefined) {
    return <p className="text-2xs leading-relaxed text-ink-faint">Reading the bank…</p>;
  }

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by name, org, project, description, or body…"
        spellCheck={false}
        className="max-w-sm text-xs md:text-xs"
        aria-label={`Filter ${bank.slug} memories`}
      />
      {visible.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          {loaded.length === 0 ? 'The bank is empty.' : 'No memory matches the filter.'}
        </p>
      ) : flat ? (
        visible.map((memory) => (
          <MemoryCard key={memory.file ?? memory.name} bank={bank} memory={memory} pane={pane} />
        ))
      ) : (
        groups.map((group) => (
          <div key={`${group.org ?? '·'}/${group.project ?? '·'}`} className="flex flex-col gap-1.5">
            <p className="pt-1 font-mono text-2xs font-medium text-ink-muted">
              {[group.org, group.project].filter((part) => part !== null).join(' / ') || 'unfiled'}
              {` · ${group.items.length}`}
            </p>
            {group.items.map((memory) => (
              <MemoryCard key={memory.file ?? memory.name} bank={bank} memory={memory} pane={pane} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function MemoryCard({
  bank,
  memory,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly memory: MemoryBankMemory;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  const provenance = [memory.added, memory.author].filter((part) => part !== null).join(' · ');

  return (
    <div className="flex flex-col gap-1 rounded-md border border-hairline bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium text-ink">{memory.name}</span>
        <ToneBadge tone="neutral">{memory.type}</ToneBadge>
        {memory.readonly ? <ToneBadge tone="neutral">mirror · read-only</ToneBadge> : null}
        <span className="ml-auto">
          {/* Retirement is a write; a read-only bank takes none, and a mirror
              memory is not the bank's to retire on any machine. */}
          {bank.role === 'readwrite' && !memory.readonly ? (
            <RetireButton bank={bank} memory={memory} pane={pane} />
          ) : null}
        </span>
      </div>
      <p className="text-2xs leading-relaxed text-ink-muted">{memory.description}</p>
      <Fold summary={<span className="text-2xs">file body</span>}>
        <CodeBlock text={memory.body} className="max-h-56" />
      </Fold>
      {provenance.length > 0 ? (
        <p className="font-mono text-2xs text-ink-faint">{provenance}</p>
      ) : null}
    </div>
  );
}

/**
 * Retirement asks first. Not because it is destructive on this machine — it
 * lands through the bank's gates like any other change, and `git revert` undoes
 * it — but because with a remote it opens a pull request the whole team sees.
 */
function RetireButton({
  bank,
  memory,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly memory: MemoryBankMemory;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-2xs text-ink-faint" disabled={pane.busy !== null}>
          {pane.busy === 'retire' ? 'Retiring…' : 'Retire…'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retire “{memory.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The memory is removed through the bank&apos;s own gates — a commit, or a pull request
            for the team to review once a remote is configured. Git history keeps it recoverable.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              pane.retire({ slug: bank.slug, name: memory.name, reason: 'retired from Artemis settings' })
            }
          >
            Retire
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Forgetting asks first: it unwires the bank and removes its installed copies. */
function ForgetButton({
  bank,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-2xs text-ink-faint" disabled={pane.busy !== null}>
          {pane.busy === 'forget' ? 'Removing…' : 'Remove…'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove “{bank.slug}” from this machine?</AlertDialogTitle>
          <AlertDialogDescription>
            The bank is unwired from every profile, its installed memories come out of project
            memory, and it is forgotten from the machine&apos;s config. The repository at{' '}
            <span className="font-mono">{bank.path}</span> stays on disk untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={() => pane.forget(bank.slug)}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Adding a bank — the onboarding moment                                      */
/* -------------------------------------------------------------------------- */

type AddMode = 'join' | 'create' | 'adopt';

/** The bank slug grammar, shared by the field, its message and the CLI. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The slug a remote URL suggests: its repository name, lowercased.
 *
 * Deliberately forgiving about the URL — this runs on every keystroke of a
 * half-typed address, and a suggestion that appears only once the URL is
 * perfect is a suggestion that appears too late to help. Anything that does
 * not reduce to a legal slug yields nothing rather than something wrong.
 */
export function slugFromRemote(remote: string): string {
  const tail = remote
    .trim()
    .replace(/[/\\]+$/, '')
    .split(/[/\\:]/)
    .filter((part) => part.length > 0)
    .at(-1);
  if (tail === undefined) return '';
  const slug = tail
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return SLUG_PATTERN.test(slug) ? slug : '';
}

/**
 * Which failed checks actually stop each mode.
 *
 * This list replaced a single machine-wide gate (`preflight.ready`, which is
 * false if *any* check failed), and the replacement is the point of the
 * change. The doctor answers for the whole machine: it probes a destination
 * directory, a `PATH` shim for the bare `cerebro` verb, a git identity for
 * commits, and — before any bank is registered — reachability of the upstream
 * repository the CLI defaults to, which is a private repo an outside user can
 * only ever fail. Joining a bank from your own git URL needs none of those. It
 * needs the CLI to be runnable and git to exist, and the remote's own
 * readability is what the Verify button is for.
 *
 * The ids are the CLI's own (`gather_checks` in `resources/cerebro`), plus
 * `cli` — main's synthesised row for "there is no CLI on this machine at all".
 *
 * Creating and adopting are gated harder, and on different things: both write
 * a commit the moment they run, so an unset git identity really does stop
 * them, and both are aimed at a directory, so the destination check is about
 * the thing the user typed rather than about a default.
 *
 * Everything left off this list still renders — a warning about `gh` is worth
 * reading before the first pull request — it simply does not disable a button.
 */
const BLOCKING_CHECKS: Readonly<Record<AddMode, readonly string[]>> = {
  join: ['cli', 'python', 'git'],
  create: ['cli', 'python', 'git', 'git-identity', 'repo'],
  adopt: ['cli', 'python', 'git', 'git-identity', 'repo'],
};

/** What a verify came to, from the click until the answer lands. */
type Verification =
  | { readonly state: 'checking' }
  | { readonly state: 'done'; readonly result: MemoryBankVerifyRemoteResponse }
  | { readonly state: 'failed'; readonly message: string };

/** What testing a secret reference came to. @see RefFields */
type RefTest =
  | { readonly state: 'checking' }
  | { readonly state: 'done'; readonly result: SecretRefTestResult }
  | { readonly state: 'failed'; readonly message: string };

/**
 * Point this bank at a secret in a key manager, instead of at a token.
 *
 * Three parts, in the order a person fills them: which manager, where in it,
 * and — the part that makes the whole thing usable — a Test that resolves the
 * reference for real and throws the value away. Without it the first time a
 * user finds out they wrote `git-token` for `git_token` is a background sync
 * that quietly stopped, days later, with nobody watching.
 *
 * The fields come from the provider's descriptor, so this renders OpenBao's
 * mount/path/key and Doppler's name/project/config without knowing which it is
 * looking at.
 */
function RefFields({
  connections,
  providerFields,
  connectionId,
  onConnection,
  values,
  onValue,
  canTest,
  test,
  onTest,
}: {
  readonly connections: readonly SecretConnectionState[];
  readonly providerFields: readonly SecretField[];
  readonly connectionId: string;
  readonly onConnection: (id: string) => void;
  readonly values: Readonly<Record<string, string>>;
  readonly onValue: (id: string, next: string) => void;
  readonly canTest: boolean;
  readonly test: RefTest | null;
  readonly onTest: () => void;
}): ReactElement {
  if (connections.length === 0) {
    return (
      <p className="text-2xs leading-relaxed text-amber">
        No key manager is connected on this machine yet. Open <em>Key managers</em> in the list on
        the left, connect OpenBao or Doppler, and this bank can hold the secret&apos;s address
        instead of the secret.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {connections.map((entry) => (
          <Button
            key={entry.connection.id}
            size="sm"
            variant={connectionId === entry.connection.id ? 'default' : 'ghost'}
            className="text-2xs"
            onClick={() => onConnection(entry.connection.id)}
          >
            {entry.connection.label}
          </Button>
        ))}
      </div>

      {connectionId.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          Choose which manager holds this bank&apos;s token.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {providerFields.map((field) => (
              <Input
                key={field.id}
                value={values[field.id] ?? ''}
                onChange={(event) => onValue(field.id, event.target.value)}
                placeholder={field.placeholder ?? field.label.toLowerCase()}
                spellCheck={false}
                className="w-44 text-xs md:text-xs"
                aria-label={field.label}
              />
            ))}
            <Button
              size="sm"
              variant="outline"
              className="text-2xs"
              disabled={!canTest || test?.state === 'checking'}
              onClick={onTest}
            >
              {test?.state === 'checking' ? 'Testing…' : 'Test'}
            </Button>
          </div>
          <p className="text-2xs leading-relaxed text-ink-faint">
            Nothing secret is stored for this bank — only this address. Every sync fetches the
            current value, so rotating it in the manager is all the rotation there is.
          </p>
          {test !== null ? <RefTestResult test={test} /> : null}
        </>
      )}
    </div>
  );
}

/**
 * What the Test came to, in the three ways it can come to something.
 *
 * The key names are the reason this is worth rendering at all: "no key named
 * git-token; it has git_token, username" is a sentence that fixes the problem,
 * where "could not read the secret" is a sentence that starts an
 * investigation. Names only — a value never appears here, on either outcome.
 */
function RefTestResult({ test }: { readonly test: RefTest }): ReactElement {
  if (test.state === 'checking') {
    return <p className="text-2xs leading-relaxed text-ink-faint">Resolving it…</p>;
  }
  if (test.state === 'failed') {
    return <p className="text-2xs leading-relaxed text-signal">{test.message}</p>;
  }
  const { found, keysAtPath, problem } = test.result;
  return (
    <div className="flex flex-col gap-1">
      <p className={`text-2xs leading-relaxed ${found ? 'text-mint' : 'text-signal'}`}>
        {found ? 'Resolved. The value was fetched and discarded — it is not stored anywhere.' : problem}
      </p>
      {keysAtPath !== undefined && keysAtPath.length > 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          Keys at that path: {keysAtPath.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

function AddGroup({
  pane,
  first,
}: {
  readonly pane: MemoryBanksPane;
  readonly first: boolean;
}): ReactElement {
  const [mode, setMode] = useState<AddMode>('join');
  /**
   * Empty means "whatever the remote suggests"; a value means the user typed
   * one and owns it from then on.
   *
   * Kept as an override rather than as the field's only source because the
   * alternative — filling the box on every keystroke of the URL — fights
   * anyone who names their bank something other than the repository, and
   * silently reverts an edit made before the URL was finished.
   */
  const [slugOverride, setSlugOverride] = useState('');
  const [remote, setRemote] = useState('');
  const [path, setPath] = useState('');
  const [readonly, setReadonly] = useState(false);
  /**
   * The access token, held here and nowhere else.
   *
   * Component state for its whole life: it goes into one `add` request and is
   * cleared the moment that succeeds. It is never put in the pane hook (which
   * outlives the form), never in the app store, and never read back from main
   * — main stores it encrypted against the bank's slug and no response shape
   * has a field it could return in.
   */
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  /**
   * Where the token comes from: typed here, or fetched from a key manager.
   *
   * `'token'` by default and unchanged for every existing user — a machine
   * with no manager configured meets the form it always met. The alternative
   * is the better arrangement and is offered rather than imposed, because
   * choosing it is a decision about where your credential lives.
   */
  const [source, setSource] = useState<'token' | 'ref'>('token');
  const secrets = useSecretManagers();
  const [connectionId, setConnectionId] = useState('');
  const [refValues, setRefValues] = useState<Record<string, string>>({});
  const [refTest, setRefTest] = useState<RefTest | null>(null);

  const connection = secrets.connections.find((entry) => entry.connection.id === connectionId);
  const refProvider = secrets.providers.find(
    (entry) => entry.id === connection?.connection.provider,
  );

  const failed = new Set(
    (pane.preflight?.checks ?? []).filter((check) => check.state === 'fail').map((check) => check.id),
  );
  const blocked = BLOCKING_CHECKS[mode].some((id) => failed.has(id));

  const trimmedRemote = remote.trim();
  /*
   * A bank joined from `…/Cortex.git` is called `cortex` unless the user says
   * otherwise. Deriving it is not a convenience: the slug grammar is
   * lowercase-and-hyphens, so the name staring at the user from their own URL
   * is one the field rejects, and the only feedback was a button that would
   * not press.
   */
  const suggestedSlug = mode === 'join' ? slugFromRemote(trimmedRemote) : '';
  const slug = slugOverride.length > 0 ? slugOverride : suggestedSlug;
  const slugOk = SLUG_PATTERN.test(slug);
  const slugProblem =
    slug.length === 0
      ? mode === 'join'
        ? 'Give the bank a short name — or paste the remote URL and one will be suggested.'
        : 'Give the bank a short name.'
      : slugOk
        ? null
        : 'Lowercase letters, digits and hyphens only — no capitals, spaces or dots.';

  const ready =
    slugOk && (mode !== 'join' || trimmedRemote.length > 0) && (mode !== 'adopt' || path.trim().length > 0);
  /**
   * Why the button will not press, or `null` when it will.
   *
   * The button was disabled by three separate conditions and explained by
   * none of them unless a requirement had failed, so the commonest case — a
   * name the grammar refuses — looked like the pane was broken.
   */
  const submitProblem = blocked
    ? 'Fix the requirements marked required above — it would fail partway through.'
    : (slugProblem ??
      (mode === 'join' && trimmedRemote.length === 0
        ? 'Paste the bank’s git remote URL.'
        : mode === 'adopt' && path.trim().length === 0
          ? 'Choose the directory that already holds the bank.'
          : null));

  /**
   * Enabled on a URL that parses, and on nothing else.
   *
   * Not on the slug, not on the preflight, not on `busy`: this is a question
   * about a remote, and the whole reason it exists is to be asked *while* the
   * rest of the form is still empty or wrong.
   */
  const canVerify = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+/i.test(trimmedRemote) || /^[^\s:]+@[^\s:]+:.+/.test(trimmedRemote);

  /**
   * The reference the form currently describes, or `null`.
   *
   * Rebuilt from the provider's declared field ids rather than from a
   * hard-coded shape, so the same form serves OpenBao's mount/path/key and
   * Doppler's name/project/config — see `KeyManagersSection` for why that
   * matters more than it looks.
   */
  const draftRef = ((): SecretRef | null => {
    if (connection === undefined) return null;
    const value = (id: string): string => (refValues[id] ?? '').trim();
    if (connection.connection.provider === 'openbao') {
      if (value('mount').length === 0 || value('path').length === 0 || value('key').length === 0) {
        return null;
      }
      return {
        provider: 'openbao',
        connectionId: connection.connection.id,
        mount: value('mount'),
        path: value('path'),
        key: value('key'),
      };
    }
    if (value('name').length === 0) return null;
    return {
      provider: 'doppler',
      connectionId: connection.connection.id,
      name: value('name'),
      ...(value('project').length > 0 ? { project: value('project') } : {}),
      ...(value('config').length > 0 ? { config: value('config') } : {}),
    };
  })();

  /** The same grammar main validates against, so the button and the handler agree. */
  const refProblem = draftRef === null ? 'incomplete' : secretRefProblem(draftRef);

  /**
   * The credential as the protocol wants it, or nothing at all.
   *
   * `undefined` rather than an empty token when nothing is supplied: an absent
   * key is how both the validator and main say "this bank has no credential",
   * and an empty one would be a credential that authenticates as nobody.
   *
   * Exactly one of the two variants, which is also what the validator
   * enforces — a request carrying both would be two answers to one question.
   */
  const credential = ((): MemoryBankAuthInput | undefined => {
    const chosen = username.trim();
    if (source === 'ref') {
      if (draftRef === null || refProblem !== null) return undefined;
      return chosen.length > 0 ? { ref: draftRef, username: chosen } : { ref: draftRef };
    }
    if (token.length === 0) return undefined;
    return chosen.length > 0 ? { token, username: chosen } : { token };
  })();

  const testRef = async (): Promise<void> => {
    if (draftRef === null) return;
    setRefTest({ state: 'checking' });
    const result = await secrets.testRef(draftRef);
    setRefTest(
      result.ok
        ? { state: 'done', result: result.value }
        : { state: 'failed', message: result.error.message },
    );
  };

  const verify = async (): Promise<void> => {
    setVerification({ state: 'checking' });
    const result = await pane.verifyRemote({
      remote: trimmedRemote,
      ...(credential === undefined ? {} : { auth: credential }),
    });
    setVerification(
      result.ok ? { state: 'done', result: result.value } : { state: 'failed', message: result.error.message },
    );
  };

  const submit = async (): Promise<void> => {
    const ok = await pane.add({
      mode,
      slug,
      role: readonly ? 'readonly' : 'readwrite',
      ...(trimmedRemote.length > 0 ? { remote: trimmedRemote } : {}),
      ...(path.trim().length > 0 ? { path: path.trim() } : {}),
      // Only a join has a remote to authenticate to, so the token cannot ride
      // along with a mode that would have nowhere to use it.
      ...(mode === 'join' && credential !== undefined ? { auth: credential } : {}),
    });
    if (ok) {
      setSlugOverride('');
      setRemote('');
      setPath('');
      setReadonly(false);
      // The token has done its one job and main has stored it; a copy left in
      // a mounted form is a copy nothing needs. The reference is cleared for a
      // weaker reason — it is not a secret — but for the same one that clears
      // the slug: this form is now describing a bank that exists.
      setToken('');
      setUsername('');
      setVerification(null);
      setRefValues({});
      setRefTest(null);
    }
  };

  return (
    <SettingsGroup label={first ? 'Set up' : 'Add a bank'}>
      {first ? (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-muted">
          No memory bank is on this machine yet. Join your team&apos;s bank from its git remote,
          create a fresh local one (shareable later — the CLI travels inside it), or adopt a
          folder that already is a bank. From then on it maintains itself: agents record durable
          facts as they surface, and every change lands as a reviewed commit or pull request.
        </p>
      ) : null}

      {pane.preflightError !== null ? (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-signal">{pane.preflightError}</p>
      ) : pane.preflight === null ? (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          Checking what this machine needs…
        </p>
      ) : (
        <RequirementList pane={pane} mode={mode} />
      )}

      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-center gap-1">
          {(['join', 'create', 'adopt'] as const).map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant={mode === candidate ? 'default' : 'ghost'}
              className="text-2xs"
              onClick={() => setMode(candidate)}
            >
              {candidate === 'join' ? 'Join a shared bank' : candidate === 'create' ? 'Create local' : 'Adopt a folder'}
            </Button>
          ))}
        </div>
        <p className="text-2xs leading-relaxed text-ink-faint">
          {mode === 'join'
            ? 'Clones the bank from its git remote. Memories you record land as auto-merging pull requests.'
            : mode === 'create'
              ? 'Starts an empty bank on this machine. No remote, no network — memories land as plain commits. Add a remote later to share it.'
              : 'Registers a directory that already holds a bank (a memories/ folder, or a projects layout declared in its cerebro.json).'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={slug}
            onChange={(event) => setSlugOverride(event.target.value)}
            placeholder="short-name (e.g. team, client-docs)"
            spellCheck={false}
            className="w-56 text-xs md:text-xs"
            aria-label="Bank slug"
          />
          {mode === 'join' ? (
            <>
              <Input
                value={remote}
                onChange={(event) => {
                  setRemote(event.target.value);
                  // A result is about the URL that produced it. Leaving it up
                  // while the field changes underneath is how a user reads a
                  // green tick for a repository they have stopped typing.
                  setVerification(null);
                }}
                placeholder="git remote URL (https or ssh)"
                spellCheck={false}
                className="w-80 text-xs md:text-xs"
                aria-label="Bank remote URL"
              />
              <Button
                size="sm"
                variant="outline"
                className="text-2xs"
                disabled={!canVerify || verification?.state === 'checking'}
                onClick={() => void verify()}
              >
                {verification?.state === 'checking' ? 'Checking…' : 'Verify'}
              </Button>
            </>
          ) : null}
          {mode !== 'join' ? (
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={mode === 'adopt' ? 'folder that holds the bank' : `~/Documents/<short-name>`}
              spellCheck={false}
              className="w-80 text-xs md:text-xs"
              aria-label="Bank path"
            />
          ) : null}
        </div>

        {mode === 'join' && verification !== null ? <VerifyResult verification={verification} /> : null}

        {mode === 'join' ? (
          <div className="flex flex-col gap-1.5">
            {/*
              Where the credential comes from, offered before it is asked for.
              Two buttons rather than a disclosure, because this is a decision
              about where your token lives rather than an advanced option — and
              a user who has connected a manager should meet the better answer
              without going looking for it.
            */}
            <div className="flex items-center gap-1">
              {(['token', 'ref'] as const).map((candidate) => (
                <Button
                  key={candidate}
                  size="sm"
                  variant={source === candidate ? 'default' : 'ghost'}
                  className="text-2xs"
                  onClick={() => {
                    setSource(candidate);
                    setVerification(null);
                  }}
                >
                  {candidate === 'token' ? 'Paste a token' : 'From a key manager'}
                </Button>
              ))}
            </div>

            {source === 'ref' ? (
              <RefFields
                connections={secrets.connections}
                providerFields={refProvider?.refFields ?? []}
                connectionId={connectionId}
                onConnection={(next) => {
                  setConnectionId(next);
                  setRefValues({});
                  setRefTest(null);
                  setVerification(null);
                }}
                values={refValues}
                onValue={(id, next) => {
                  setRefValues((current) => ({ ...current, [id]: next }));
                  setRefTest(null);
                  setVerification(null);
                }}
                canTest={draftRef !== null && refProblem === null}
                test={refTest}
                onTest={() => void testRef()}
              />
            ) : (
              <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="password"
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                    setVerification(null);
                  }}
                  placeholder="access token (optional — for private repos)"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-80 text-xs md:text-xs"
                  aria-label="Access token (optional — for private repos)"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-2xs text-ink-faint"
                  onClick={() => setShowAdvanced((open) => !open)}
                >
                  {showAdvanced ? 'Hide username' : 'Username…'}
                </Button>
              </div>
              <p className="text-2xs leading-relaxed text-ink-faint">
                Stored encrypted on this machine and used only for this bank&apos;s remote — background
                syncs need it too, so it outlives this form. An ssh remote needs no token: it
                authenticates with your key.
              </p>
              </>
            )}
            {/*
              The username matters just as much for a reference — GitLab reads
              it, and git quotes it back — so the way to reach it cannot live
              only beside the token field.
            */}
            {source === 'ref' ? (
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-2xs text-ink-faint"
                  onClick={() => setShowAdvanced((open) => !open)}
                >
                  {showAdvanced ? 'Hide username' : 'Username…'}
                </Button>
              </div>
            ) : null}
            {showAdvanced ? (
              <div className="flex flex-col gap-1">
                <Input
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    setVerification(null);
                  }}
                  placeholder="x-access-token"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-56 text-xs md:text-xs"
                  aria-label="Username"
                />
                <p className="text-2xs leading-relaxed text-ink-faint">
                  Leave this alone for GitHub, Forgejo or Gitea — they authenticate on the token and
                  ignore the name. A GitLab deploy token needs the token&apos;s own username, and a
                  Bitbucket app password needs your account name. Never put the token here: git
                  quotes the username back in its error messages.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        <label className="flex items-center gap-2 text-2xs text-ink-muted">
          <input
            type="checkbox"
            checked={readonly}
            onChange={(event) => setReadonly(event.target.checked)}
          />
          Read-only on this machine — consult it, never draft, promote, or retire into it
        </label>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={pane.busy !== null || blocked || !ready} onClick={() => void submit()}>
            {pane.busy === 'add'
              ? mode === 'join'
                ? 'Joining…'
                : mode === 'create'
                  ? 'Creating…'
                  : 'Adopting…'
              : mode === 'join'
                ? 'Join bank'
                : mode === 'create'
                  ? 'Create bank'
                  : 'Adopt bank'}
          </Button>
          <Button size="sm" variant="ghost" disabled={pane.busy !== null} onClick={pane.refresh}>
            Re-check
          </Button>
          {submitProblem !== null ? (
            <span className="text-2xs text-amber">{submitProblem}</span>
          ) : null}
        </div>
      </div>
    </SettingsGroup>
  );
}

/**
 * What the remote said, in the four ways it can say it.
 *
 * Drawn differently per outcome because the *remedies* differ and only some of
 * them are the user's. Amber for "needs a token" — nothing is wrong, there is
 * one more thing to supply — and red for a URL that names nothing or a host
 * that would not answer. Collapsing all three into red text with git's own
 * wording is how someone with a typo spends an afternoon generating access
 * tokens.
 *
 * The detail is git's own sentence, already scrubbed in main. Shown rather
 * than paraphrased: `Repository not found` and `could not read Username` are
 * the two most useful strings in this whole flow.
 */
function VerifyResult({ verification }: { readonly verification: Verification }): ReactElement {
  if (verification.state === 'checking') {
    return <p className="text-2xs leading-relaxed text-ink-faint">Asking the remote…</p>;
  }
  if (verification.state === 'failed') {
    return <p className="text-2xs leading-relaxed text-signal">{verification.message}</p>;
  }

  const { outcome, headPresent, detail } = verification.result;
  const tone = outcome === 'ok' ? 'mint' : outcome === 'auth-required' ? 'amber' : 'signal';
  const headline =
    outcome === 'ok'
      ? headPresent
        ? 'Reachable — this machine can read it'
        : 'Reachable, and empty — joining it starts the bank'
      : outcome === 'auth-required'
        ? 'The remote wants credentials — add an access token below and verify again'
        : outcome === 'not-found'
          ? 'No repository there — check the URL, or ask for access if it is private'
          : outcome === 'invalid-url'
            ? 'That URL cannot be used'
            : 'Could not reach the remote';

  return (
    <div className="flex items-start gap-2 text-2xs leading-relaxed">
      <StatusDot tone={tone} className="mt-1" />
      <span className="min-w-0 flex-1">
        <span className={tone === 'mint' ? 'text-mint' : tone === 'amber' ? 'text-amber' : 'text-signal'}>
          {headline}
        </span>
        {detail.length > 0 ? <span className="ml-1.5 break-words text-ink-faint">{detail}</span> : null}
      </span>
    </div>
  );
}

/**
 * The requirements, each with its fix, and each marked with whether it stops
 * the button.
 *
 * Shown before onboarding rather than after a failure: every one of these has
 * a one-line remedy, and a user who learns about a missing git identity from a
 * half-finished clone has been told the least useful version of the truth.
 * `warn` rows stay visible — "works, but you will open pull requests by hand"
 * is worth knowing before the first one appears.
 *
 * A failed row that does not block the chosen mode keeps its red dot and loses
 * its authority: it says `not needed to join`. Hiding it instead was the other
 * option and it is worse — these rows are the machine's honest condition, and
 * a user who fixes a real problem later should be able to see it here now.
 * What must not happen is the reverse of what used to: a failing probe of a
 * repository the user has never heard of disabling the button that joins the
 * one they have.
 */
function RequirementList({
  pane,
  mode,
}: {
  readonly pane: MemoryBanksPane;
  readonly mode: AddMode;
}): ReactElement {
  const checks = pane.preflight?.checks ?? [];
  const blocking = BLOCKING_CHECKS[mode];
  const verb = mode === 'join' ? 'join' : mode === 'create' ? 'create' : 'adopt';

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      {checks.map((entry) => {
        const required = blocking.includes(entry.id);
        return (
          <div key={entry.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 text-2xs">
              <StatusDot
                tone={entry.state === 'ok' ? 'mint' : entry.state === 'warn' ? 'amber' : 'signal'}
              />
              <span className="font-medium text-ink">{entry.label}</span>
              {entry.state === 'fail' ? (
                <ToneBadge tone={required ? 'signal' : 'neutral'}>
                  {required ? 'required' : `not needed to ${verb}`}
                </ToneBadge>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-ink-faint" title={entry.detail}>
                {entry.detail}
              </span>
            </div>
            {entry.state !== 'ok' && entry.remedy !== null ? (
              <p className="pl-4 font-mono text-2xs leading-relaxed text-ink-muted">{entry.remedy}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
