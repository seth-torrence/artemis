/**
 * Confirming a session delete.
 * ============================================================================
 *
 * Deleting a session removes its transcript from disk — the provider's own
 * file, not a record Artemis keeps — so it is gone from the provider's CLI too
 * and there is nothing to restore from. That is what this dialog is guarding,
 * and it is why the guard is a confirmation rather than an undo: an undo would
 * have to hold a copy of the thing the user asked to destroy.
 *
 * ## Two dialogs, not one dialog with a warning
 *
 * A session that is still running gets a *different* confirmation, which
 * replaces the ordinary one rather than adding a line to it. The distinction
 * matters because the two are answering different questions:
 *
 *  - The ordinary one asks "do you mean to destroy this?" The risk is the data.
 *  - The running one asks "do you mean to destroy this *while it is working*?"
 *    The risk is the data **and** a live agent whose transcript is about to be
 *    pulled out from under it.
 *
 * Someone who has clicked through the ordinary dialog a dozen times has learned
 * its shape, and a warning added into that familiar frame is exactly the thing
 * a practised eye skips. So the running case gets its own title, its own
 * leading sentence and its own button verb — the muscle memory does not carry
 * over, which is the entire point.
 *
 * ## Why the running check is asynchronous
 *
 * "Still running" cannot be answered from this window's state: a run started in
 * another window is just as live and just as much a reason to stop. The main
 * process's run registry is the only place that knows about all of them, so the
 * dialog opens in a brief `checking` state and commits to a variant once it has
 * an answer. Rendering the ordinary dialog first and swapping it for the
 * warning mid-read would be worse than a moment's delay — the user could have
 * confirmed before the warning arrived.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { AlertTriangleIcon, Trash2Icon } from 'lucide-react';
import type { SessionSummary } from '@rx-artemis/protocol';

import { condenseTitle } from '@rx-artemis/transcript';
import { deleteSession, isSessionRunning } from '../state/store';
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
import { Spinner } from '@/components/ui/spinner';

/**
 * What we know about the session's run state.
 *
 * `checking` is a real state rather than an optimistic default, for the reason
 * in the file header: guessing "not running" and correcting later would let the
 * user confirm before the warning appeared.
 */
type RunCheck = 'checking' | 'idle' | 'running';

export function DeleteSessionDialog({
  session,
  onClose,
}: {
  readonly session: SessionSummary;
  readonly onClose: () => void;
}): ReactElement {
  const [check, setCheck] = useState<RunCheck>('checking');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void isSessionRunning(session.id).then((running) => {
      if (live) setCheck(running ? 'running' : 'idle');
    });
    return () => {
      live = false;
    };
  }, [session.id]);

  const confirm = (): void => {
    setBusy(true);
    /*
     * The dialog closes on its own once the store has answered, rather than on
     * the click. A delete that fails reports through the banner surface, and
     * closing first would put that message on screen with no visible cause —
     * the row would still be there and nothing would say why.
     */
    void deleteSession(session).finally(onClose);
  };

  const title = condenseTitle(session.title);

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Never dismiss mid-write: the row is about to change underneath it.
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia
            className={check === 'running' ? 'bg-amber/15 text-amber' : 'text-destructive'}
          >
            {check === 'running' ? (
              <AlertTriangleIcon aria-hidden="true" />
            ) : (
              <Trash2Icon aria-hidden="true" />
            )}
          </AlertDialogMedia>

          {check === 'running' ? (
            <>
              <AlertDialogTitle>This session is still running</AlertDialogTitle>
              <AlertDialogDescription>
                “{title}” has a run in progress — possibly in another window. Deleting it now
                destroys the transcript out from under the agent that is writing it, and the work
                still in flight is lost with it. This cannot be undone.
              </AlertDialogDescription>
            </>
          ) : (
            <>
              <AlertDialogTitle>Delete this session?</AlertDialogTitle>
              <AlertDialogDescription>
                “{title}” and its full transcript will be erased from disk. It will no longer
                appear in Artemis or in the provider’s own CLI. This cannot be undone — to hide a
                session without destroying it, archive it instead.
              </AlertDialogDescription>
            </>
          )}
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/*
           * `onClick` with `preventDefault`, not a bare action: the default
           * closes the dialog on click, and the close is owed to the store's
           * answer instead. See `confirm`.
           *
           * The verb differs between the two variants for the same reason the
           * titles do — "Delete anyway" is an answer to a question that was
           * asked, and it does not read as the button someone has clicked a
           * dozen times before.
           */}
          <AlertDialogAction
            variant="destructive"
            disabled={busy || check === 'checking'}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {busy ? <Spinner /> : null}
            {check === 'running' ? 'Delete anyway' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
