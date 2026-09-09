# Context

The ubiquitous language for Artemis. User-facing copy, code identifiers, and docs
use these terms in these senses; when a word here and the code disagree, one of
them is wrong — fix it or fix this.

## Glossary

**Profile** — an identity Artemis can run an agent as: a provider plus a config
directory holding its credential and settings. The "who runs it." A profile is
not an account; it *names* one.

**Plan** — the subscription capacity behind a profile: its rate-limit windows,
their utilization, and their resets.

**Conversation** — the user-facing term for an exchange with an agent. Never
"thread" in user-facing copy.

**Session** — the technical identity of a conversation: the id under which its
transcript is stored and resumed. Every conversation has one; users see
conversations, code moves sessions.

**Run** — one turn cycle of an agent working on a conversation. A run belongs to
the profile it started on for its whole life.

**Hand off** — moving a conversation to a different runner, with the user's
consent, along either axis: another *profile* (who runs it) or another *machine*
(where it runs). Always offered, never automatic without explicit standing
agreement.

**Continuity note** — the document an agent writes about its in-flight work when
a hand off cannot carry the conversation live (formerly the "handoff document").
The payload of a degraded hand off.

**Surface** — a work tab that accompanies a conversation: terminal, browser,
file, preview, delegated-agent transcript, tasks. Surfaces belong to a
conversation, not to the window.

**Pane** — a slot in the window's grid displaying one conversation.

**Suggested task** — follow-up work an agent *offers* at the end of a turn, drawn
as a chip under its answer. Deliberately not a "task": the Tasks surface holds
*delegated work*, which is running, and a suggested task has not started and may
never. Offering is never doing — where a chosen one runs (this session, a new
one, a worktree, a server) is the user's choice.

**Seed** — the small set of values (canvas, accent) from which a theme's full
token ramp is derived.
