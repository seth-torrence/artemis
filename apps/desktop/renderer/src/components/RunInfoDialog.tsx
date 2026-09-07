/**
 * Run details and the provider capability matrix.
 *
 * This is what became of the right-hand detail panel. The panel's *inspector*
 * half is gone for good — tool input and output now expand in place inside the
 * transcript, where the call is, so there is nothing left to send to a pane.
 * What could not be inlined is here: facts about the run as a whole, the usage
 * readout, and the capability matrix.
 *
 * The matrix earns a home rather than being dropped, for two reasons. It is the
 * honest answer to "why is that greyed out?", and it is the only place the
 * capabilities that are *not* controls can be seen at all — nothing in the UI
 * can gate on `partialMessages` or `subagents`, because they change how output
 * is rendered rather than what the user may press. Each row says what it
 * actually changes, so "is this capability gated anywhere?" stays answerable
 * when a tenth one is added.
 *
 * A dialog rather than a pane: this is consulted, not watched. Making it
 * permanent cost a third of the window to answer a question asked once a day.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { CheckIcon, XIcon } from 'lucide-react';
import type { Capabilities } from '@rx-artemis/protocol';

import { CAPABILITY_LABELS, type CapabilityKey } from '../hooks/useCapability';
import { contextRatio, formatDuration, formatTokens, formatUsd } from '@rx-artemis/transcript';
import { shortenPath } from '../lib/paths';
import {
  activeCapabilities,
  activeEffort,
  activeModel,
  activeProfile,
  activeProvider,
  activeProviderLabel,
  setInfo,
  useApp,
} from '../state/store';
import { usePane } from '../state/paneContext';
import { Row, StatusDot, ToneBadge, type Tone } from './primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Display order, and — in the second field — what each capability actually
 * changes in *this* UI. Written down because a capability with no entry here is
 * a capability nobody has decided about.
 */
const CAPABILITY_NOTES: readonly (readonly [CapabilityKey, string])[] = [
  ['partialMessages', 'Rendering only: text arrives as tokens rather than whole blocks.'],
  ['interactivePermissions', 'Whether a run can pause for an inline approval prompt at all.'],
  ['midRunSteering', 'Gates the composer while a run is live.'],
  ['resumeSession', 'Gates picking a past session in the command palette.'],
  ['forkSession', 'Gates “fork the current session”, and fork-from-a-message under a user turn.'],
  ['rewind', 'Gates the rewind control under a settled user turn.'],
  ['listSessions', 'Gates the session list and the reload command.'],
  ['subagents', 'Rendering only: tool rows may be attributed to a subagent.'],
  ['usageReporting', 'Gates the context readout in the status line.'],
  ['costReporting', 'Whether a price is shown beside the context readout.'],
];

const STATUS_TONE: Record<string, Tone> = {
  starting: 'cyan',
  running: 'cyan',
  awaiting_permission: 'amber',
  ended: 'neutral',
};

export function RunInfoDialog(): ReactElement {
  const open = useApp((s) => s.infoOpen);
  const providerLabel = usePane(activeProviderLabel);

  return (
    <Dialog open={open} onOpenChange={setInfo}>
      <DialogContent className="flex max-h-[calc(100%-4rem)] w-full max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-hairline px-4 py-3">
          <DialogTitle className="text-sm font-semibold tracking-tight text-ink">
            Run details
          </DialogTitle>
          <DialogDescription className="text-2xs leading-snug">
            What this run is, what it is billed against, and what {providerLabel} can do.
          </DialogDescription>
        </DialogHeader>

        {/*
         * A plain overflow container, not shadcn's `ScrollArea`, and the reason
         * is worth writing down because it looks like an inconsistency.
         *
         * Radix's ScrollArea sizes its viewport with `height: 100%`, which only
         * resolves against a parent with a *definite* height. This dialog's
         * height comes from `max-h` clamping its content, which is indefinite —
         * so the viewport measured the full content height, overflowed the
         * dialog, and the capability matrix at the bottom was simply clipped
         * with no way to reach it. `min-h-0 flex-1` plus `overflow-y-auto`
         * needs no percentage resolution and works either way.
         *
         * `ScrollArea` is still right where the parent has a definite height —
         * the profile screen, which is `absolute inset-0`, uses it correctly.
         * The scrollbar here is the native one, which `index.css` already
         * styles thin and quiet.
         */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="px-4 py-3">
            <Section title="Run">
              <RunBlock />
            </Section>
            <Section title="Account">
              <AccountBlock />
            </Section>
            <Section title="Usage">
              <UsageBlock />
            </Section>
            <Section title={`${providerLabel} capabilities`}>
              <CapabilityMatrix />
            </Section>
            <ToolsBlock />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="mb-3">
      <h3 className="mb-1 chrome-label text-ink-faint">{title}</h3>
      <div className="rounded-lg border border-hairline bg-inset/60 px-2 py-1.5">{children}</div>
    </section>
  );
}

function RunBlock(): ReactElement {
  const run = usePane((s) => s.run);
  const model = usePane(activeModel);
  const effort = usePane(activeEffort);

  if (!run) {
    return (
      <>
        <p className="py-1 text-2xs text-ink-faint">
          No run yet. The next prompt will start one with the settings below.
        </p>
        <Row label="model">{model?.label ?? 'provider default'}</Row>
        <Row label="thinking">{effort?.label ?? 'provider default'}</Row>
      </>
    );
  }

  return (
    <>
      <Row label="status">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot
            tone={STATUS_TONE[run.status] ?? 'neutral'}
            pulse={run.status === 'running' || run.status === 'starting'}
          />
          {run.status.replace(/_/g, ' ')}
        </span>
      </Row>
      <Row label="run">{run.runId.slice(0, 12)}…</Row>
      <Row label="session">{run.sessionId ? `${run.sessionId.slice(0, 12)}…` : '—'}</Row>
      {/* What the run *reports*, not what was asked for. The provider may have
          substituted, and this is the only place the difference is visible. */}
      <Row label="model">{run.model ?? '—'}</Row>
      <Row label="thinking">{effort?.label ?? 'provider default'}</Row>
      <Row label="mode">{run.permissionMode ?? '—'}</Row>
      <Row label="cwd">{run.cwd}</Row>
      {run.status === 'ended' ? (
        <Row label="ended">{run.endReason?.replace(/_/g, ' ') ?? 'ended'}</Row>
      ) : (
        <ElapsedRow startedAt={run.startedAt} />
      )}
      {run.error ? (
        <p className="mt-1.5 font-mono text-2xs leading-snug text-signal">{run.error.message}</p>
      ) : null}
    </>
  );
}

/**
 * A live clock for a running run.
 *
 * Owns its own interval instead of being recomputed on render: nothing else
 * here updates while text streams — deliberately, since the transcript's whole
 * design keeps deltas out of React — so without a tick of its own the elapsed
 * time would sit frozen mid-run.
 */
function ElapsedRow({ startedAt }: { readonly startedAt: number }): ReactElement {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <Row label="elapsed">{formatDuration(Math.max(0, Date.now() - startedAt))}</Row>;
}

/**
 * Which account this run is billed to.
 *
 * The config directory *is* the answer — it holds the credential — so the path
 * is what gets shown, alongside whoever the last status read said was signed in
 * there. A stale reading is possible and harmless: this is a diagnostic panel,
 * and the profile screen is where the authoritative check lives.
 */
function AccountBlock(): ReactElement {
  const profile = usePane(activeProfile);
  const platform = useApp((s) => s.platform);
  const status = useApp((s) => (profile ? s.authByProfile[profile.id] : undefined));

  if (!profile) return <p className="py-1 text-2xs text-ink-faint">No profile selected.</p>;

  return (
    <>
      <Row label="profile" mono={false}>
        {profile.label}
      </Row>
      <Row label="account">
        <span className={status !== undefined && !status.loggedIn ? 'text-amber' : undefined}>
          {status === undefined
            ? '—'
            : status.loggedIn
              ? [status.email ?? status.orgName ?? 'signed in', status.subscriptionType]
                  .filter(Boolean)
                  .join(' · ')
              : 'not signed in'}
        </span>
      </Row>
      <Row label="config">
        <span title={profile.configDir}>
          {shortenPath(profile.configDir, { platform, max: 36 })}
        </span>
      </Row>
    </>
  );
}

function UsageBlock(): ReactElement {
  const usage = usePane((s) => s.run?.usage);
  const reporting = usePane((s) => activeCapabilities(s).usageReporting);
  const costing = usePane((s) => activeCapabilities(s).costReporting);

  if (!reporting) {
    return <p className="py-1 text-2xs text-ink-faint">This provider does not report token usage.</p>;
  }
  if (!usage) return <p className="py-1 text-2xs text-ink-faint">No usage reported yet.</p>;

  const ratio = contextRatio(usage);
  return (
    <>
      <Row label="scope">{usage.scope}</Row>
      <Row label="input">{formatTokens(usage.tokens.inputTokens)}</Row>
      <Row label="output">{formatTokens(usage.tokens.outputTokens)}</Row>
      {usage.tokens.cacheReadInputTokens === undefined ? null : (
        <Row label="cache read">{formatTokens(usage.tokens.cacheReadInputTokens)}</Row>
      )}
      {usage.tokens.cacheCreationInputTokens === undefined ? null : (
        <Row label="cache write">{formatTokens(usage.tokens.cacheCreationInputTokens)}</Row>
      )}
      <Row label="cost">
        {costing ? (
          <span className="text-beam-text">{formatUsd(usage.costUsd)}</span>
        ) : (
          <span className="text-ink-faint">not reported</span>
        )}
      </Row>
      {ratio === undefined ? null : (
        <div className="mt-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-2xs text-ink-faint">context</span>
            <span className="font-mono text-2xs text-ink-muted">
              {formatTokens(usage.contextTokens)} / {formatTokens(usage.contextWindow)}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Context window used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            className="mt-1 h-1 overflow-hidden rounded-full bg-line"
          >
            <div
              className={cn('h-full rounded-full', ratio > 0.85 ? 'bg-signal' : 'bg-cyan')}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
        </div>
      )}
    </>
  );
}

function CapabilityMatrix(): ReactElement {
  const capabilities: Capabilities = usePane(activeCapabilities);
  return (
    <>
      {CAPABILITY_NOTES.map(([key, note]) => {
        const on = capabilities[key];
        return (
          <div key={key} className="flex items-start justify-between gap-2 py-[3px]">
            <span className="min-w-0">
              <span className={cn('text-2xs', on ? 'text-ink-muted' : 'text-ink-faint line-through')}>
                {CAPABILITY_LABELS[key]}
              </span>
              {on ? null : <span className="block text-2xs leading-snug text-ink-faint">{note}</span>}
            </span>
            {on ? (
              <CheckIcon className="size-3 shrink-0 text-mint" aria-label="supported" />
            ) : (
              <XIcon className="size-3 shrink-0 text-ink-faint" aria-label="not supported" />
            )}
          </div>
        );
      })}
      <div className="mt-1.5 border-t border-hairline pt-1.5">
        <span className="text-2xs text-ink-faint">permission modes</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {capabilities.permissionModes.length === 0 ? (
            <span className="font-mono text-2xs text-ink-faint">none</span>
          ) : (
            capabilities.permissionModes.map((mode) => (
              <ToneBadge
                key={mode}
                tone={mode === 'bypassPermissions' ? 'signal' : 'neutral'}
                // Not uppercased, unlike every other tone badge: these are
                // camelCase protocol identifiers, and "ACCEPTEDITS" reads as one
                // word rather than two.
                className="normal-case"
              >
                {mode}
              </ToneBadge>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function ToolsBlock(): ReactElement | null {
  const tools = usePane((s) => s.run?.tools);
  if (!tools || tools.length === 0) return null;
  return (
    <Section title="Tools available to this run">
      <div className="flex flex-wrap gap-1">
        {tools.map((tool) => (
          <ToneBadge key={tool}>{tool}</ToneBadge>
        ))}
      </div>
    </Section>
  );
}
