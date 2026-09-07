/**
 * The composer.
 * ============================================================================
 *
 * One auto-growing textarea pinned between the transcript and the status line.
 * Everything that used to sit in a settings strip under it — permission mode,
 * the fork switch — has moved to the status line and the command palette, so
 * this is what it looks like: a place to type.
 *
 * Five behaviours are load-bearing:
 *
 *  - **Enter sends, Shift+Enter breaks the line.** With `isComposing` honoured,
 *    so an IME candidate selection does not fire the prompt.
 *  - **Up on an empty composer recalls the previous prompt**, and keeps walking
 *    back; Down walks forward and off the end back to empty. Only when the
 *    composer is empty *and* the caret is at the start, so Up inside a
 *    half-written multi-line prompt still moves the caret.
 *  - **Escape denies a parked permission prompt if there is one, and otherwise
 *    interrupts the run.** Both meanings unblock a stuck agent, which is what
 *    the key is for here; denying takes precedence because a parked run cannot
 *    be interrupted into a clean state while a decision is owed.
 *  - **It stays usable mid-run** when the provider advertises `midRunSteering`.
 *    When it does not, the field is disabled *with the reason attached* rather
 *    than quietly swallowing keystrokes.
 *  - **One button at the end of the field, offering whichever action would
 *    work.** Stop while a run is live and there is nothing to send; Send the
 *    moment there is. See {@link Composer} for why it is one button and not
 *    two, and why "nothing to send" is not the same as "empty".
 *  - **Images attach by paste, by drop, or from a picker**, and all three land
 *    in the same place. Paste is the one that matters: a screenshot goes to the
 *    clipboard, and the gesture after taking one is Cmd+V.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react';
import {
  CircleStopIcon,
  HandIcon,
  FileTextIcon,
  GitForkIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  SendHorizontalIcon,
  XIcon,
} from 'lucide-react';
import {
  ATTACHMENT_LIMITS,
  attachmentBytes,
  isImageAttachment,
  type Attachment,
} from '@rx-artemis/protocol';

import { useCapability } from '../hooks/useCapability';
import { keyLabel } from '../hooks/useHotkeys';
import {
  acceptSuggestion,
  denyPendingPermission,
  dismissHandoff,
  dismissSuggestion,
  interruptRun,
  isLive,
  offerManualHandoff,
  writeHandoffDoc,
  offeredSuggestion,
  pushBanner,
  refreshCommands,
  setForkOnResume,
  submitPrompt,
  useApp,
} from '../state/store';
import { HANDOFF_BLOCK_DETAIL } from '../state/autoHandoff';
import { usePane, usePaneRef } from '../state/paneContext';
import { paneState, setPaneState } from '../state/pane';
import {
  attachmentSrc,
  fileKindLabel,
  filesFrom,
  formatBytes,
  readAttachments,
  type AttachmentRejection,
} from '../lib/attachments';
import { registerComposer } from '../lib/composerFocus';
import { COLUMN_MAX } from './Transcript';
import { applySlashCommand, matchSlashCommands } from '../lib/slashCommands';
import { ActivityRule } from './Activity';
import { ParkedAsks } from './ParkedAsks';
import { SlashCommandMenu, SLASH_LISTBOX_ID, slashOptionId } from './SlashCommandMenu';
import { ReasonButton, WithReason } from './disabled-reason';
import { WorkingDirectoryChip } from './WorkingDirectory';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The column the composer sits on — the transcript's, exactly.
 *
 * Every row this file lays out (the directory chip, the queued-steer strip,
 * the field itself, the hand-off strip) takes this class instead of a private
 * `max-w-4xl`. The private cap is how the input ended up narrower than the
 * messages above it: three surfaces, three opinions about one column. Now the
 * transcript's `COLUMN_MAX` is the only opinion (2026-08-30, the 7D pass).
 */
function useColumnMax(): string {
  return COLUMN_MAX[useApp((s) => s.conversationWidth)];
}

/**
 * Chromium sizes a textarea to its content natively with `field-sizing`, which
 * is what the `field-sizing-content` class on shadcn's `Textarea` asks for. The
 * manual fallback below only runs where that is unsupported — running both
 * would mean JS fighting the layout engine for the element's height.
 */
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content');

/**
 * Report what could not be attached.
 *
 * One banner for the batch rather than one per file: dropping a folder of
 * twelve things onto the composer is a single mistake, and twelve banners about
 * it is a second one.
 */
function reportRejections(rejected: readonly AttachmentRejection[]): void {
  if (rejected.length === 0) return;
  const [first] = rejected;
  if (first === undefined) return;
  pushBanner(
    'warn',
    rejected.length === 1
      ? `Could not attach ${first.name}`
      : `Could not attach ${String(rejected.length)} files`,
    rejected.map((entry) => `${entry.name}: ${entry.reason}`).join('\n'),
  );
}

export function Composer(): ReactElement {
  const columnMax = useColumnMax();
  /**
   * How far back through `promptHistory` recall has walked. `null` is "not
   * recalling" — the distinction matters, because index 0 is a real entry.
   */
  const [recall, setRecall] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  /**
   * Whether a drag is currently over the composer.
   *
   * A counter would be the usual fix for `dragleave` firing as the pointer
   * crosses a child element, but the drop target here has no children the
   * pointer can reach — the highlight is drawn on the wrapper and the textarea
   * inside it is the only child. `relatedTarget` handles the rest.
   */
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /*
   * Everything below is this column's, and none of it is the window's. A
   * composer in a split view that read the focused pane would send the right
   * column's prompt into the left column's run the moment focus moved — which
   * is why the pane is taken once, here, and passed to every action rather
   * than left to default.
   */
  const pane = usePaneRef();

  /*
   * Offer this field to the store's imperative half. ⌘J bounces the caret
   * between the shell and the composer — see `toggleTerminal` — and the second
   * half of that bounce can only be done from out here through a seam like
   * this one; the store has no ref to reach. Registering is not focusing:
   * nothing moves until an action asks.
   */
  useEffect(
    () => registerComposer(pane.id, () => textareaRef.current?.focus()),
    [pane.id],
  );
  /*
   * The draft lives in the pane, not in `useState` here.
   *
   * Opening or closing a column re-parents the surviving column in the React
   * tree, which unmounts it — so component-local text would be discarded by an
   * action about *the other* conversation. See `SessionState.draft`.
   */
  const text = usePane((s) => s.draft);
  const setText = useCallback(
    (value: string) => setPaneState(pane, { draft: value }),
    [pane],
  );
  const live = usePane(isLive);
  const pending = usePane((s) => s.permissionQueue.length);
  // "Approve" is the wrong word for a question, and pointing at the wrong card
  // is how a user ends up hunting for an Approve button that is not there.
  const asking = usePane((s) => s.permissionQueue.every((r) => r.question !== undefined));
  const steering = useCapability('midRunSteering');
  const images = useCapability('imageInput');
  const files = useCapability('fileInput');
  const resuming = usePane((s) => s.resumeSessionId);
  const fork = usePane((s) => s.forkOnResume);
  const history = usePane((s) => s.promptHistory);
  /*
   * The provider's guess at the next prompt, already gated for staleness —
   * `offeredSuggestion` is the one place that decides whether the pair in the
   * pane still describes the turn on screen. Null the moment a new run starts,
   * so nothing here needs to watch for that.
   */
  const suggestion = usePane(offeredSuggestion);
  /*
   * How many steers the provider has not been seen to read — the length of the
   * pane's queued set, which is also what the control row under each of those
   * messages reads. A number rather than the array, because a selector that
   * returned the array would hand zustand a fresh identity whenever the run
   * object was rebuilt and re-render the composer on every keystroke elsewhere
   * in the column; the strip only ever needed the count.
   *
   * Gated on `live` at the selector so the strip cannot outlive the run it
   * describes: the set is emptied when a continuation turn opens, but between
   * `run.end` and that claim the run is simply not live and there is nothing
   * to interrupt.
   */
  const queuedSteers = usePane((s) => (isLive(s) ? (s.run?.queuedSteers?.length ?? 0) : 0));

  const locked = live && !steering.supported;

  /*
   * The slash command menu.
   *
   * Two sources, and the run wins when there is one. A run's list is what the
   * session actually loaded — the provider's built-ins plus anything
   * `contentBridge.ts` bridged in, kept current by `session.commands` — while
   * `state.commands` is what the provider *said* it would offer, asked by
   * `refreshCommands` when the column settled on an account and a directory.
   *
   * The second source is the point. The list used to arrive only with a run, so
   * a column between conversations had nothing to offer and the menu stayed shut
   * until the first message — which is exactly where a slash command is most
   * often typed. It costs a subprocess spawned before anyone has asked for
   * anything, which was the original reason not to; it buys the menu at the
   * start of a conversation, which is where it was wanted all along.
   *
   * A provider that enumerates none — Codex, which has no user-authored command
   * surface — still never opens the menu, with no check needed here.
   */
  const commands = usePane((s) => s.run?.slashCommands ?? s.commands ?? undefined);
  /*
   * The fallback for typing faster than the prefetch.
   *
   * `refreshCommands` runs at boot and on every settle, so by the time anyone
   * reaches for a command the list is nearly always already there. Nearly: a
   * fresh split, an account just added, or a launch slow enough to be typed over
   * all arrive here with `null` — and a menu that stayed shut for the rest of
   * the session because of a race would be indistinguishable from the bug this
   * replaced. Asking again is idempotent and the main process caches by
   * (provider, profile, directory), so being wrong costs one message.
   *
   * Keyed on the draft becoming a slash rather than on mount, so a column nobody
   * types a `/` into never spawns anything on this path.
   */
  const unasked = usePane((s) => s.run === null && s.commands === null);
  const reaching = text.startsWith('/');
  useEffect(() => {
    if (unasked && reaching) void refreshCommands(pane);
  }, [unasked, reaching, pane]);
  /**
   * Escape closed the menu for this draft.
   *
   * Needed because the menu is *derived* from the text rather than opened: with
   * no flag, the only way to close it while `/cer` is still in the field would be
   * to delete what the user typed, and a dismissal that eats the draft is worse
   * than no dismissal. Cleared by the next edit, so typing on brings it back.
   */
  const [dismissed, setDismissed] = useState(false);
  const menu = dismissed ? null : matchSlashCommands(commands, text);
  const [highlight, setHighlight] = useState(0);
  /*
   * The highlight is clamped rather than reset on every keystroke.
   *
   * Typing narrows the list, and a list that got shorter than the highlight
   * would leave Enter aiming past the end. Clamping keeps the selection near
   * where the user left it instead of throwing them back to the top on every
   * character.
   */
  const selected = menu === null ? 0 : Math.min(highlight, menu.matches.length - 1);

  /** Accept a command: replace the draft with it and leave the caret after it. */
  const acceptCommand = useCallback(
    (name: string) => {
      setText(applySlashCommand(name));
      setHighlight(0);
      textareaRef.current?.focus();
    },
    [setText],
  );

  /**
   * Whether the field is holding a prompt that pressing the button would send.
   *
   * Not `text.length > 0`: a field of whitespace sends nothing, and a locked
   * composer sends nothing whatever is in it.
   */
  const sendable = !locked && text.trim().length > 0;

  /**
   * Which action the button at the end of the field is offering.
   *
   * One button, not two. Stop used to sit outside the field as a red pill that
   * appeared for the length of a run and pushed the composer sideways, next to
   * a Send that was disabled for most of that time — two controls where one is
   * ever usable, and the usable one was the one that moved.
   *
   * So the button offers whichever action would actually do something. While a
   * run is live with nothing to send it is Stop; type a prompt to steer with
   * and it becomes Send again, because at that point the user is aiming at
   * their own sentence and a Stop under the cursor is a trap.
   *
   * "Nothing to send" is deliberately {@link sendable} rather than "the field
   * is empty", and the difference is what keeps a live run stoppable: a
   * composer that cannot steer holds text it can do nothing with, and a Send
   * disabled with an explanation would leave the run with no stop at all. The
   * rule that has to survive any edit here is that a live run is always
   * stoppable — from this button, or from Escape, which does it either way and
   * is what the title promises.
   */
  const stops = live && !sendable;

  /*
   * The click has been answered but the run has not ended yet.
   *
   * Everything between those two moments belongs to the provider — the
   * interrupt is an IPC call into a control channel that takes seconds to wind
   * a busy turn down — and for all of it this button used to sit unchanged,
   * offering a Stop that had already been pressed. `interruptRun` writes the
   * flag before it touches the wire, so this is true in the same frame as the
   * click; what it buys is the difference between "stopping…" and a button
   * that looks broken for exactly as long as it is working.
   *
   * Gated on `isLive` at the selector, like `queuedSteers` above: `run.end`
   * settles the pane and this must settle with it, not linger on a run that
   * is over.
   */
  const stopping = usePane((s) => isLive(s) && s.run?.interruptRequested === true);

  /** Slots left, per kind — the two have separate budgets. */
  const imageCount = attachments.filter(isImageAttachment).length;
  const slots = {
    images: ATTACHMENT_LIMITS.images - imageCount,
    files: ATTACHMENT_LIMITS.files - (attachments.length - imageCount),
  };
  const full = slots.images <= 0 && slots.files <= 0;
  /** Nothing at all can be attached — the provider takes neither kind. */
  const attachable = images.supported || files.supported;

  /**
   * Take files from wherever they came from.
   *
   * Every entry point funnels through here so that the count limits, the image
   * resizing and the rejection reporting cannot drift apart between paste, drop
   * and the picker.
   */
  const attach = useCallback(
    async (dropped: readonly File[]): Promise<void> => {
      if (dropped.length === 0) return;
      if (!attachable) {
        pushBanner('warn', 'This provider cannot take attachments', images.reason);
        return;
      }

      // Read against the slots free *now*; the state update below re-checks
      // against the slots free when it lands, because reading is async and the
      // user can paste twice in the time it takes. A kind the provider cannot
      // carry gets zero slots, so it is rejected with a reason rather than
      // attached and silently dropped at send time.
      const { accepted, rejected } = await readAttachments(dropped, {
        images: images.supported ? slots.images : 0,
        files: files.supported ? slots.files : 0,
      });
      reportRejections(rejected);
      if (accepted.length === 0) return;
      setAttachments((current) => {
        const merged = [...current, ...accepted];
        const keptImages = merged.filter(isImageAttachment).slice(0, ATTACHMENT_LIMITS.images);
        const keptFiles = merged
          .filter((attachment) => !isImageAttachment(attachment))
          .slice(0, ATTACHMENT_LIMITS.files);
        // Re-ordered so images lead, which is the order they are sent in and
        // the order the strip reads best in — thumbnails, then filenames.
        return [...keptImages, ...keptFiles];
      });
    },
    [attachable, files.supported, images.reason, images.supported, slots.files, slots.images],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const grow = useCallback(() => {
    if (SUPPORTS_FIELD_SIZING) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  }, []);

  useEffect(grow, [grow, text]);

  /*
   * Swallow drops that miss the composer.
   *
   * Without this the window itself handles the drop, which for a file means a
   * navigation to `file://…`. The main process already refuses that (see
   * `hardenWebContents`), so nothing unsafe happens — but "nothing unsafe" is
   * the whole app going blank in the failure case, and a near-miss on the
   * composer is a normal thing for a person to do with a picture.
   */
  useEffect(() => {
    const swallow = (event: Event): void => {
      event.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  const send = useCallback(() => {
    const value = textareaRef.current?.value ?? text;
    if (value.trim().length === 0) return;

    const sent = attachments;
    setText('');
    setRecall(null);
    // Cleared with the text rather than on the round-trip: an attachment
    // belongs to the prompt it went with, and leaving it in the field would put
    // it silently on the next one too.
    setAttachments([]);

    // Into *this* pane. A composer that let the argument default would send the
    // right column's prompt into the left column's run the moment focus moved.
    void submitPrompt(value, sent, pane).then((accepted) => {
      // …but a prompt that never left is a different thing. `submitPrompt`
      // refuses outright when there is no working directory or no profile, and
      // it says so by returning false; the text survives that on Up-arrow
      // recall, and images have no such second chance. Putting them back is the
      // difference between a fixable mistake and a trip back to the screenshot
      // tool.
      //
      // Only into a strip the user has not refilled in the meantime — reading
      // `current` rather than closing over the old value is what makes an image
      // pasted during the round-trip survive.
      if (!accepted && sent.length > 0) {
        setAttachments((current) => (current.length === 0 ? sent : current));
      }
    });
  }, [attachments, text, pane, setText]);

  /**
   * Walk the prompt history.
   *
   * `delta` of -1 is "older". Walking past the newest entry lands on an empty
   * composer rather than sticking on the last prompt, so Down is a way out of
   * recall and not a trap.
   */
  const walk = useCallback(
    (delta: number): boolean => {
      if (history.length === 0) return false;
      const current = recall ?? history.length;
      const next = current + delta;
      if (next < 0) return false;
      if (next >= history.length) {
        setRecall(null);
        setText('');
        return true;
      }
      setRecall(next);
      setText(history[next] ?? '');
      return true;
    },
    [history, recall, setText],
  );

  // Nothing renders under the input row, deliberately: two rows lived there —
  // a resume banner and a keyboard-hint strip — and both were permanent chrome
  // restating what a user learns once.
  //
  // One real control went with them: the fork toggle. Fork is still settable
  // from the command palette, but it is no longer visible or reversible here,
  // so a session set to fork gives no sign of it until it branches. If that
  // bites, the toggle needs its own home; don't bring the whole row back.
  /*
   * No panel fill and no top border.
   *
   * The composer used to sit in a darker bar drawn across the foot of the
   * window, which read as a second surface the transcript ended at. It is the
   * same document: the input is the last thing in the column, not furniture
   * beneath it. So the field draws its own card — the wrapper below carries the
   * hairline and the wash, not the `Textarea` primitive — and floats on the
   * window background, with the status line under it; nothing boxes either of
   * them in.
   *
   * The seam itself is the exception, and it is one line.
   *
   * A hairline used to sweep across here while a run was live, saying only
   * "something is happening" — and it was removed for saying that in the one
   * place the reader is not looking. What is there now is not that hairline: it
   * is the *border* between the conversation and the prompt, which the seam
   * wanted anyway, and it carries the run's state rather than the bare fact of
   * one. The words still live at the foot of the transcript, where the question
   * "what is it doing" is actually asked. See `ActivityRule`.
   */
  return (
    <div className="shrink-0">
      <ActivityRule />
      <HandoffStrip />

      {/*
        The directory, above the input and aligned to its left edge.

        It is a heading for what follows rather than a setting on it. Everything
        on the status line *under* the composer answers "what will the next
        prompt do"; this answers "where am I", which is the frame the rest sits
        inside. Reading order matches: place, then prompt, then settings.
      */}
      <div className={cn('mx-auto flex w-full items-center px-3 pt-1.5', columnMax)}>
        <WorkingDirectoryChip />
        {/*
          Opposite the directory, at the other end of the same row: the two
          facts about where this conversation lives and where it could go
          next. Ghosted, because it is a door rather than an action — nothing
          moves until the menu is answered.
        */}
        <HandoffButton />
      </div>

      {/*
        What the run is parked on, pinned here until answered.

        Above the field rather than at the point in the transcript where it
        was asked, because this is the one part of the column that is on
        screen wherever the conversation is scrolled — a card that scrolls off
        the top with the status line still counting it is an agent waiting on
        an answer nobody can find. The transcript keeps a marker in its place
        that jumps here. See `ParkedAsks`.
      */}
      <ParkedAsks columnMax={columnMax} />

      {/*
        A message sent into a running turn, still waiting to be read.

        The provider folds a mid-turn message in at its next tool break;
        one that misses every break runs as the next turn instead. Until one
        of those happens the message is queued, and this row says so — with
        the lever Claude Code offers in the same spot: interrupt the current
        step, and the provider takes the queued message immediately. The
        interrupt is safe for exactly that reason — queued messages survive
        it by design.
      */}
      {queuedSteers > 0 && (
        <div className={cn('mx-auto w-full px-3 pt-1', columnMax)}>
          {/*
            7D's `.queue` strip: a hairline row on a wash, not bare text. It is
            a standing state above the field rather than a line of prose, and
            the card it sits over is bordered too — an unbounded sentence there
            reads as part of the transcript.
          */}
          <div className="flex items-center gap-1.5 rounded-md border border-hairline bg-wash px-2.5 py-1.5">
            <span className="min-w-0 truncate text-2xs text-ink-muted">
              {queuedSteers === 1
                ? '1 message queued — read at the next pause, or after this turn'
                : `${queuedSteers} messages queued — read at the next pause, or after this turn`}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void interruptRun(pane)}
              title="Interrupt the current step — queued messages survive and are read immediately"
              className="ml-auto h-5 shrink-0 gap-1 rounded-md px-1.5 text-2xs font-normal text-beam-text hover:bg-wash-strong hover:text-beam-text dark:hover:bg-wash-strong"
            >
              <CircleStopIcon className="size-3 shrink-0" aria-hidden="true" />
              Read it now
            </Button>
          </div>
        </div>
      )}

      {/* One child now that Stop has moved inside the field; the row is what
          centres the composer and gives it its margins. */}
      <div className={cn('mx-auto flex w-full items-end px-3 pt-1 pb-1', columnMax)}>
        {/*
          The positioning context for Send is this element, not `WithReason`.
          `WithReason` renders its children bare — no wrapper, no `className` —
          whenever there is no reason to show, which is the normal case here. A
          `relative` handed to it would exist only while the composer was
          locked, so the button would fall out of the field in the one state
          nobody is looking at it in.
        */}
        {/*
          The drop target is the whole field wrapper, not the textarea.

          A textarea has its own drag behaviour — a dragged *file* over one shows
          an insertion caret, as though it were about to be typed — and the
          wrapper is what the thumbnail strip lives in anyway, so the highlight
          covers everything a person would aim at.
        */}
        <div
          className={cn(
            /*
              The card. 7D `.cin`: an 11px radius, the stronger hairline (12%
              of the ink rather than 7%) and a 4% wash for a fill — the field
              is the one surface in the column a person operates, so it is the
              one thing allowed to be drawn as an object rather than as text
              on the window. The textarea inside it is transparent and
              borderless; this element carries the edge for the whole card,
              attachments and buttons included.
            */
            'relative min-w-0 flex-1 rounded-[10px] border border-hairline-strong bg-wash',
            /*
              Focus is drawn out here for the same reason: a ring on the
              textarea would trace a second, smaller rectangle inside the one
              the eye is already reading as the field. `focus-within` rather
              than `focus-visible` because the ring belongs to whichever child
              has the caret, and a textarea is focus-visible on click anyway.
            */
            'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
            // `ring-offset-bg` named no token — there is no `--color-bg`, so
            // the offset had no colour and Tailwind emitted nothing. And
            // `ring-accent` is shadcn's *hover surface*, not the accent colour,
            // which drew a near-invisible grey ring around a drop target that
            // exists to be obvious. Both are the design's own names now.
            dragging && 'ring-2 ring-beam ring-offset-2 ring-offset-abyss',
          )}
          onDragOver={(event: DragEvent<HTMLDivElement>) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            // Both required: without `preventDefault` the browser refuses the
            // drop, and without `dropEffect` the cursor claims it will move the
            // file rather than copy it.
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDragging(true);
          }}
          onDragLeave={(event: DragEvent<HTMLDivElement>) => {
            // `relatedTarget` is where the pointer went. Still inside means the
            // pointer crossed the textarea, not the edge.
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragging(false);
            // A drop that carried no files — text, a URL — has nothing to
            // attach. What *is* in the files is `attach`'s to judge: it takes
            // every kind now, and rejects with a per-file reason of its own.
            const files = filesFrom(event.dataTransfer);
            if (files.length === 0) return;
            void attach(files);
          }}
        >
          <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />

          {/*
            Above the field, not below it. The composer is already at the bottom
            of the window, so a menu underneath would be clipped by the edge —
            and growing upward keeps the row being typed in the same place
            instead of pushing the whole field down as matches narrow.
          */}
          {menu !== null && (
            <SlashCommandMenu
              matches={menu.matches}
              highlight={selected}
              onAccept={acceptCommand}
              onHighlight={setHighlight}
            />
          )}

          <WithReason
            reason={locked ? steering.reason : undefined}
            className="w-full"
            side="top"
          >
            <Textarea
              ref={textareaRef}
              value={text}
              disabled={locked}
              rows={1}
              spellCheck={false}
              aria-label="Prompt"
              /*
                Combobox semantics without moving focus. The textarea stays the
                focused element — the user is typing — so the highlighted row is
                announced through `aria-activedescendant` rather than by focusing
                it, which is the pattern for an editable field that owns a list.
              */
              role="combobox"
              aria-expanded={menu !== null}
              aria-autocomplete="list"
              aria-controls={SLASH_LISTBOX_ID}
              {...(menu === null
                ? {}
                : { 'aria-activedescendant': slashOptionId(selected) })}
              /*
                The provider's predicted next prompt rides the placeholder slot
                as ghost text inside the field — the Claude Code idiom — rather
                than a chip above it. The placeholder is already the field's
                resident ghost, so the prediction shows exactly where the eye
                already reads hints, disappears the moment the user types, and
                occupies no chrome. Tab materialises it into the draft to be
                edited or sent — it is never sent on the user's behalf — and
                Escape declines it. Lock and permission messages outrank it:
                a prediction must not paper over "why can't I type".
              */
              placeholder={
                locked
                  ? `Waiting for the run to finish — ${steering.reason}`
                  : pending > 0
                    ? asking
                      ? 'The agent is waiting on your answer, just above this box…'
                      : 'A tool call is waiting for your approval, just above this box…'
                    : suggestion !== null
                      ? suggestion
                      : live
                        ? 'Steer the run…'
                        : resuming
                          ? 'Continue the selected session…'
                          : 'Ask Artemis to do something…'
              }
              title={
                suggestion !== null && text.length === 0
                  ? `Suggested reply — ${keyLabel('tab')} to accept, ${keyLabel('escape')} to dismiss`
                  : undefined
              }
              onChange={(event) => {
                setText(event.target.value);
                // Any edit leaves recall: the text on screen is no longer a
                // history entry, so Up should start again from the newest.
                setRecall(null);
                // An edit also revives a menu Escape closed — the dismissal was
                // about the draft as it stood, not a preference.
                setDismissed(false);
              }}
              /*
                Paste is the reason this feature exists.

                `preventDefault` runs only when the clipboard actually held an
                image. Copying a *file* in Finder puts both the file and its
                name on the clipboard, and a paste that ate the text as well
                would be a regression for anyone pasting a path — so the text
                keeps its default behaviour and the image is taken alongside it.
              */
              onPaste={(event) => {
                const files = filesFrom(event.clipboardData);
                if (files.length === 0) return;
                event.preventDefault();
                void attach(files);
              }}
              onKeyDown={(event) => {
                const el = event.currentTarget;

                /*
                 * The menu goes first, and has to.
                 *
                 * Every key it wants is a key the composer already means
                 * something else by: Enter sends, Escape stops the run, Up
                 * recalls history. While the menu is open those meanings are all
                 * wrong — Enter on a half-typed `/cer` would send the literal
                 * text and get `Unknown command` back — so the menu claims them
                 * and the handlers below only ever see the keys it did not want.
                 *
                 * It never claims Enter with a modifier: Shift+Enter is a
                 * newline, and taking it would make a menu that is merely open
                 * unable to be typed past.
                 */
                if (menu !== null) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const step = event.key === 'ArrowDown' ? 1 : -1;
                    const count = menu.matches.length;
                    // Wraps, because a menu of two entries is faster to cycle
                    // than to walk to the end of.
                    setHighlight((selected + step + count) % count);
                    return;
                  }
                  if (
                    (event.key === 'Enter' || event.key === 'Tab') &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    acceptCommand(menu.matches[selected]!.name);
                    return;
                  }
                  if (event.key === 'Escape') {
                    // Closes the menu and stops there — deliberately *not*
                    // falling through to the run interrupt. One Escape should
                    // dismiss one thing, and killing the run because a menu was
                    // open would be a surprise the user cannot undo. The draft
                    // survives: see `dismissed`.
                    event.preventDefault();
                    setDismissed(true);
                    return;
                  }
                }

                /*
                 * Tab accepts the suggestion, and only from an empty field.
                 *
                 * Empty is the honest scope: with text in the field Tab may be
                 * the user tabbing away, and accepting would replace what they
                 * wrote with a machine's guess. The slash menu cannot collide —
                 * it claims Tab only while the draft starts with `/`, which is
                 * never the empty field this requires.
                 */
                if (
                  event.key === 'Tab' &&
                  !event.shiftKey &&
                  suggestion !== null &&
                  text.length === 0 &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  // Capture before accepting: the accept nulls the offer, and
                  // the caret belongs after the text that just became real so
                  // typing continues the sentence instead of prepending to it.
                  const accepted = suggestion;
                  acceptSuggestion(pane);
                  requestAnimationFrame(() => {
                    textareaRef.current?.setSelectionRange(accepted.length, accepted.length);
                  });
                  return;
                }

                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                  return;
                }

                /*
                 * Escape declines a showing ghost suggestion before it means
                 * anything else — but only when it cannot also mean "stop" or
                 * "deny": a live run or a parked permission outranks tidying a
                 * hint, and the gates below make sure this branch never
                 * swallows those. With the field non-empty the ghost is not
                 * showing, so Escape falls through untouched.
                 */
                if (
                  event.key === 'Escape' &&
                  suggestion !== null &&
                  text.length === 0 &&
                  !live &&
                  pending === 0
                ) {
                  event.preventDefault();
                  dismissSuggestion(pane);
                  return;
                }

                // Escape from inside the composer, because the global handler
                // deliberately ignores text fields and this is the one place the
                // user is guaranteed to be typing.
                //
                // The stop is gated on the same preference as the global
                // handler's, and denying a parked permission is not: this is the
                // second half of the rule written out in `App.tsx`, and the two
                // have to agree or Escape would mean one thing in the field and
                // another an inch above it.
                if (event.key === 'Escape') {
                  event.preventDefault();
                  void denyPendingPermission(pane).then((denied) => {
                    if (denied || !useApp.getState().escapeStopsRun) return;
                    if (paneState(pane).run?.status !== 'ended') void interruptRun(pane);
                  });
                  return;
                }

                // Recall only from the very start of the field. Anywhere else Up
                // and Down are caret movement, and stealing them would make a
                // multi-line prompt unnavigable.
                const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
                if (event.key === 'ArrowUp' && atStart && (text.length === 0 || recall !== null)) {
                  if (walk(-1)) event.preventDefault();
                  return;
                }
                if (event.key === 'ArrowDown' && recall !== null && atStart) {
                  if (walk(1)) event.preventDefault();
                }
              }}
              className={cn(
                // No easement on the right any more: the buttons live in the
                // card's own bar below (7D `.cbar`) rather than floating over
                // this corner, so the text keeps the card's whole width.
                //
                // No `font-mono`. What gets typed here is a sentence, and it is
                // the one surface where the app is being spoken to rather than
                // read, so it takes the same face as the bubble it becomes and
                // as the answer that comes back. The two have to move together:
                // see the note on the user bubble in `Transcript.tsx`.
                'max-h-[35vh] min-h-11 w-full resize-none px-3 py-2.5 text-sm leading-relaxed md:text-sm',
                /*
                  Every edge and fill the primitive draws is surrendered to the
                  card wrapper above — border, background and focus ring alike.
                  `dark:bg-transparent` is not redundant with `bg-transparent`:
                  the primitive's `dark:bg-input/30` is a `.dark`-scoped rule
                  and outranks the unscoped one whatever the source order.
                */
                'border-transparent bg-transparent focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent',
                locked && 'cursor-not-allowed',
              )}
            />
          </WithReason>

          {/*
            Inside the field, pinned to its bottom-right.

            Each button is square and *fixed* at 28px, which is the field's 36px
            minimum less 4px of inset each side — so at one line they read as
            filling the height, and when the text wraps they keep that size and
            travel down with the growing edge. Anchoring the row to `bottom`
            rather than centring is what makes that true: centred, they would
            drift to the middle of a tall field and stop lining up with the line
            being typed.

            Send is the filled square now, and the ghost argument that used to
            sit here — that a fill would out-shout the sentence being written —
            was an argument about a composer with no edges of its own. The card
            draws those edges now (7D `.cin`), and inside a card the primary
            action is the thing that is expected to be filled; a ghost arrow in
            the corner of a bordered field reads as decoration rather than as
            the button Enter presses. Attach stays a ghost beside it, which is
            what makes the pair legible as one action and one accessory.

            Icons only. The words carried nothing the glyphs and the Enter hint
            in the empty state do not; `aria-label` and the titles keep them
            named for anyone not reading the glyph.
          */}
          {/*
            The card's own bottom bar — 7D `.cbar`. The buttons used to float
            over the textarea's corner, which kept the card one row tall and
            cost a `pr-18` easement inside the field. A bar under the text is
            the mockup's silhouette: accessory on the left, the hint and the
            action on the right, and the textarea keeps its whole width.
          */}
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            {/*
              Attach sits to Send's left, in the same lane and at the same size.

              Ordering is the reading order of the action: pick the picture,
              then send it. It is also the safer of the two arrangements — Send
              stays the rightmost thing in the field, where it has always been,
              so muscle memory does not open a file dialog.

              The hidden input is what actually opens the picker. A native
              dialog through the main process would hand back a *path*, which
              would then have to be read on the renderer's say-so; the input
              element hands over the bytes the user themselves selected and
              needs no new IPC channel to do it.

              No `accept` filter, deliberately. The agent has `Read`, `Grep` and
              a shell, so the set of files it can do something with is wider
              than any list here would stay current with — and an `accept` that
              greys out the user's own `.parquet` in the OS picker is a worse
              answer than attaching it and letting the agent try.
            */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                // Reset first: picking the same file twice in a row fires no
                // `change` at all if the value is still sitting there.
                event.target.value = '';
                void attach(picked);
              }}
            />
            <ReasonButton
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={locked || !attachable || full}
              disabledReason={
                !attachable
                  ? images.reason
                  : full
                    ? `A prompt can carry ${String(ATTACHMENT_LIMITS.images)} images and ${String(ATTACHMENT_LIMITS.files)} files.`
                    : locked
                      ? steering.reason
                      : undefined
              }
              aria-label="Attach a file"
              title="Attach a file — or paste or drop one"
              className="size-7 shrink-0 rounded-md p-0 text-ink-muted hover:bg-wash-strong hover:text-ink dark:hover:bg-wash-strong"
            >
              <PaperclipIcon />
            </ReasonButton>

            {/*
              Send and Stop share this slot; see `stops` above for which is on
              screen when. Both are the same 28px filled square in the same
              place, so the swap is a change of colour and glyph rather than of
              layout — nothing moves under the pointer as a run starts or ends.

              Signal rather than beam, and filled rather than tinted. The two
              buttons have to be told apart at a glance while the pointer is
              already over the slot, and at 28px a hue swap on one filled shape
              does that where a fill-versus-ghost swap would read as the button
              having gone away.
            */}
            <div className="flex-1" />
            <span
              aria-hidden="true"
              className="mr-1.5 text-2xs text-ink-faint select-none max-sm:hidden"
            >
              ⏎ send · ⇧⏎ newline
            </span>
            {stops ? (
              /*
                Acknowledged the moment it is pressed. The glyph becomes the
                house spinner and the button goes quiet — pressing it again
                could do nothing more than the first press already did, and a
                Stop still offering itself after being clicked is what reads
                as the app not having heard. Escape stays live the whole time
                (`interruptRun` is idempotent and deliberately un-gated), so
                the run is never left without a stop if the first one is lost.
              */
              <Button
                variant="default"
                onClick={() => void interruptRun(pane)}
                disabled={stopping}
                aria-label={
                  stopping ? 'Stopping the run…' : `Stop the run (${keyLabel('escape')})`
                }
                title={stopping ? 'Stopping the run…' : `Stop the run (${keyLabel('escape')})`}
                className="size-7 shrink-0 rounded-md bg-signal p-0 text-signal-ink hover:bg-signal/85 disabled:opacity-100"
              >
                {stopping ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <CircleStopIcon />
                )}
              </Button>
            ) : (
              <Button
                variant="default"
                onClick={send}
                // No `ReasonButton` and no reason to attach: the one state that
                // had one — locked mid-run — is now Stop, and the disabled
                // field above still explains itself.
                disabled={!sendable}
                aria-label={`Send the prompt (${keyLabel('enter')})`}
                title={`Send the prompt (${keyLabel('enter')})`}
                className="size-7 shrink-0 rounded-md bg-beam p-0 text-beam-ink hover:bg-beam/85"
              >
                <SendHorizontalIcon />
              </Button>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

/**
 * What is attached, above the field it will be sent from.
 *
 * Two shapes, because the two kinds answer "which one is this?" differently.
 *
 * An **image** shows its picture. Half of what lands here is a pasted
 * screenshot with no filename at all, and of the half that has one, "Screenshot
 * 2026-08-11 at 14.03.22.png" tells the user nothing about which screenshot it
 * is. The picture is the label.
 *
 * A **file** has nothing to show, so it shows what it is: name, kind and size.
 * The size is there because it is the number that decides whether attaching it
 * was a good idea, and because it is the same number the agent will be told.
 *
 * Nothing renders when there is nothing attached — not an empty row, not a
 * dashed drop zone. The composer is a place to type, and a permanent box
 * advertising a feature you are not using is the chrome this file has spent
 * several rounds removing.
 */
function AttachmentStrip({
  attachments,
  onRemove,
}: {
  readonly attachments: readonly Attachment[];
  readonly onRemove: (id: string) => void;
}): ReactElement | null {
  if (attachments.length === 0) return null;

  /*
   * Inside the card, so the strip takes the card's inset rather than a margin
   * under itself — 7D `.att` pads from the field's own edge and lets the
   * textarea's own padding provide the gap below.
   */
  return (
    <ul className="flex flex-wrap items-start gap-1.5 px-2 pt-2" aria-label="Attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="relative">
          {isImageAttachment(attachment) ? (
            <img
              src={attachmentSrc(attachment)}
              // The filename when there is one, so a screen reader and a hover
              // both name the thing. `alt` is not decorative here: this is
              // content the user added and can remove.
              alt={attachment.name ?? 'Attached image'}
              title={attachment.name ?? 'Attached image'}
              className="size-14 rounded-md border border-hairline object-cover"
            />
          ) : (
            /*
              Sized to the thumbnails' height so the strip keeps one baseline,
              but free to be as wide as the name needs up to a cap — a filename
              squeezed into a square would defeat the point of showing it.
            */
            <div
              title={`${attachment.name} — ${formatBytes(attachmentBytes(attachment))}`}
              className="flex h-14 max-w-56 items-center gap-2 rounded-md border border-hairline bg-wash px-2.5"
            >
              <FileTextIcon className="size-4 shrink-0 text-ink-muted" />
              <span className="min-w-0">
                {/* `break-all` over `truncate`: the informative half of a
                    filename is often its end (`…-final-v3.csv`), and a middle
                    ellipsis is not something CSS can do. Two lines of a long
                    name beats one line of its prefix. */}
                <span className="line-clamp-2 font-mono text-2xs leading-tight break-all text-ink">
                  {attachment.name}
                </span>
                <span className="block text-2xs text-ink-muted">
                  {fileKindLabel(attachment)} · {formatBytes(attachmentBytes(attachment))}
                </span>
              </span>
            </div>
          )}
          {/*
            Remove is always visible, not hover-only.

            A control that appears on hover is a control that does not exist for
            anyone navigating by keyboard, and the whole point of this strip is
            that something attached by accident — the wrong screenshot, a paste
            into the wrong window — can be taken back before it is sent and
            billed for.
          */}
          <button
            type="button"
            onClick={() => {
              onRemove(attachment.id);
            }}
            aria-label={`Remove ${attachment.name ?? 'this image'}`}
            title="Remove"
            className="absolute -top-1 -right-1 flex size-4.5 items-center justify-center rounded-full border border-hairline-strong bg-panel text-ink-muted opacity-80 transition-opacity hover:text-ink hover:opacity-100 focus-visible:opacity-100"
          >
            <XIcon className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Why this composer will not send, and the one button that changes that.
 *
 * The refusal itself is in `submitPrompt`, where the decision belongs, and it
 * puts a banner up — but a banner is a notification and this is a *state*. It
 * persists until someone acts on it, so it needs somewhere it persists on
 * screen, and the only honest place is directly above the field it is
 * disabling. A block whose remedy is not next to it reads as the app being
 * broken.
 *
 * Renders nothing in every other state, including `asked`: while the agent is
 * writing the document the composer works normally, and a strip saying so would
 * be an announcement rather than a control.
 */
/**
 * Hand off — the deliberate version of what a plan limit does automatically.
 *
 * Two answers, and both begin by stopping the run: handing a live conversation
 * to another account, or writing a briefing while the agent is still typing
 * into it, is how two runs end up appending to one transcript.
 *
 * **To another session** opens the same picker the automatic path opens
 * (`HandoffPicker`), with every profile that can reach this conversation's
 * transcript. Reachability is the floor rather than a preference: a session
 * lives inside one profile's config directory, so an account that cannot read
 * it cannot continue it, and offering it anyway would be offering a failure.
 *
 * **A hand-off document** asks the agent for a briefing and leaves the
 * conversation where it is. It lands in the *project* — never in a linked
 * worktree, which is made for one branch and deleted when that branch lands.
 * See `handoffProjectRoot`.
 */
function HandoffButton(): ReactElement {
  const pane = usePaneRef();
  const started = usePane((s) => s.resumeSessionId !== null);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          title="Hand this conversation to another account, or write a hand-off document"
          className="ml-auto h-[22px] shrink-0 gap-1.5 rounded-md px-2 text-2xs font-normal text-ink-faint hover:bg-wash hover:text-ink-muted"
        >
          <HandIcon className="size-3 shrink-0" aria-hidden="true" />
          Hand off
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {/*
          Shown disabled with the reason rather than hidden, the rule
          `disabled-reason.tsx` sets out: a conversation that has not started
          has no transcript for another account to continue, and the sentence
          is what teaches that. The document has no such floor — there is
          always something to write down.
        */}
        <DropdownMenuItem
          disabled={!started}
          title={
            started
              ? undefined
              : 'This conversation has not started, so there is nothing for another account to continue.'
          }
          onSelect={() => void offerManualHandoff(pane)}
        >
          Hand off to another session
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void writeHandoffDoc(pane)}>
          Write hand-off doc
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HandoffStrip(): ReactElement | null {
  const pane = usePaneRef();
  const state = usePane((s) => s.handoff);
  const columnMax = useColumnMax();
  if (state !== 'done') return null;

  return (
    <div className={cn('mx-auto w-full px-3 pt-1.5', columnMax)}>
      <div className="flex items-start gap-3 rounded-lg border border-amber/40 bg-panel px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-medium text-amber">This conversation has been handed over</p>
          <p className="mt-0.5 text-2xs leading-relaxed text-ink-faint">{HANDOFF_BLOCK_DETAIL}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 border-hairline-strong px-2 text-2xs"
          onClick={() => dismissHandoff(pane)}
        >
          Keep working here
        </Button>
      </div>
    </div>
  );
}
