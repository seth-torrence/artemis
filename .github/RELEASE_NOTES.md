Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 2.8.0

A memory bank says how it is filed, a served run reads your standing instructions, and a bypass-permissions run works from a root container that says it is the sandbox.

**A memory bank says how it is filed.** A bank's own `cerebro.json` is read now: its layout (memories flat under `memories/`, or nested inside each project under `projects/<org>/<project>/memories/`), its default org, and an `instructions` file its maintainers wrote for agents. The prompt Artemis composes follows what it reads. A bank filed by project refuses a draft that names no existing project, and the command the prompt used to hand out failed on the first draft of every session — it now carries `--org` and `--project` and says what they name and where to look. A bank's own notes are carried after Artemis's text, for a bank this machine may write to. One more sentence settles a confusion that ran through every transcript: `cerebro` is the name of the tool, and the bank is called whatever you named it. A project opened for the first time gets the bank installed for that project at its first run, rather than at the next bank commit; a bank is recognised by its declared layout, not only by a `memories/` folder.

**A served run reads your standing instructions.** A conversation held with an Artemis server was told none of your prompt library; now the library crosses the wire and is appended on top of the serving provider's preset, where that provider can take one. Where it cannot — a Codex or OpenCode account — the server sets it aside and says so on the first chunk, and the transcript carries one line about it rather than a run that quietly went without. The memory-bank prompt a served run gets describes the banks on the machine it runs on: the server composes it from its own registry, and the desktop keeps its own bank prompt at home.

**Bypass permissions from a root container that says it is the sandbox.** A server running as root withheld `bypassPermissions` from its Claude accounts because Claude Code refuses the flag under root — but the CLI's own rule has an opt-in, `IS_SANDBOX=1`, for a container whose only user is root. The catalogue mirrors that rule exactly, so a server started with the variable offers the mode it can serve. `docker-compose.yml` documents the opt-in and what it costs.

**Artemis's own prompt can be deleted, and stays deleted.** The team-memory-bank prompt could be switched off but never removed; a deleted row came straight back on the next read. The removal is recorded now, Delete sits beside Reset on the row, and a "Bring back" button under the list returns the prompt in its shipped state.

**A document stands where the agent made it.** A page, an SVG or a markdown file the agent writes for you now sits in the thread at the point it was written, between the sentence that announced it and the one that followed, instead of stacking under the fold at the foot of the turn. The header's opener has a **Documents** row with the count, and the dock lists every document the conversation has made, each row opening the document, its source, or the place in the thread where it was made.

**The header's chips never cover the search.** With an update ready and a conversation waiting, the two chips painted over the search field on any window under about 1400px on Windows. Each side of the header now keeps at least the width of its own controls, and the search is what gives up room.

**cerebro 0.8.1.** The memory-bank CLI refuses an install that would empty a project — a bank whose files it cannot read, or a layout it does not know — instead of installing nothing and pruning every project's copy, which is what an older CLI did when pointed at a bank laid out in a way it could not read. A host may name the project a sync installs into, refusals name the bank's projects, and a bank may name an `instructions` file.

## What's new in 2.7.3

Two repairs to conversations held with an Artemis server.

**A served turn answers once.** Every turn that used a tool drew its whole
answer twice — once as it streamed, then again underneath, whole. The second
copy was the closing block arriving after the activity rows had already
settled the first, with nothing on it to say which block it finished. It says
so now, and the answer lands once. A turn that used no tools was never
affected, which is what made it look intermittent.

**A served turn shows its thinking.** Reasoning never crossed the wire at all:
the server had nowhere to put it that was not the answer itself, so it dropped
it. It now travels beside the answer, in the field the reasoning-capable
OpenAI-shaped servers already use, and the thinking rows appear where the
model wrote them. A subagent's own words stay out of the answer too — they
were being read back into it, so a delegated agent's findings arrived inline
and then again in the agent's account of them.

**A dropped connection no longer ends the turn.** A laptop that slept, a
tunnel that went down or a server that restarted mid-turn left the pane
holding "Could not reach the Artemis server" while the run carried on
elsewhere, unwatched and unreadable. The run was always kept; there was simply
no way back to it. Now the pane says the link went, reconnects on its own, and
picks the answer up from the last thing it drew. Quiet stretches carry a
heartbeat, so a stream that has genuinely died is noticed in seconds rather
than at the end of a turn that never comes.

## What's new in 2.7.2

**A turn that produced nothing now says so.** A run can end having said
nothing, run nothing and thought nothing — the provider queued the message
rather than answering it — and all either app showed for that was a dim
`52ms · 0 tok`. That reads as the agent shrugging, and there was no way to
tell it apart from a turn whose accounting happens to be small. The terminal
now leads that row with "no reply"; the desktop names it rather than calling
it "completed" and, more to the point, stops hiding it, since a clean run's
block is suppressed under two of the three run-summary settings and a message
answered by silence was left with no row under it at all.

**Thinking is shown whole.** Long reasoning was flattened into one line and
then cut off at 200 characters. The desktop gets away with a preview because
its block folds open on demand; a terminal row has no fold, so the end of a
thought was simply unreadable. It now renders in full, in the paragraphs it
was written in.

## What's new in 2.7.1

Two repairs to how the terminal app reads.

**The plan meters have colour.** They went red at 90% and amber at 75%
already, but below that the bar was dim grey — a gauge that looks switched
off rather than one with room in it. The filled cells and the number now take
green, amber and red on the same thresholds the desktop's rings use, while
the empty cells stay dim so the bar reads as a level rather than a coloured
block.

**The agent's mark no longer runs into its text.** `⏺` has an emoji
presentation in many terminal fonts — a rounded square with a hollow circle —
and is drawn two cells wide where the gutter allows one, leaving no gap
before the message. It is a plain `●` now, one cell wide everywhere.

## What's new in 2.7.0

The terminal app lets you leave a turn running, and is easier to read while
it does.

**Switch conversations while one is working.** Switching used to be refused
until a turn finished, which made the one thing worth doing during a long
turn — going and reading something else — the one thing you could not do. Now
the turn keeps running: its transcript goes on filling in the background and
switching back is instant, with nothing re-read. Starting a new conversation,
moving to another folder, and switching account all work the same way, and
`/resume` no longer waits either.

**The rail says what each conversation is doing.** `●` marks the one you are
in, `◐` one still working, and a yellow `⚿` one that has stopped to ask
permission — the last being the only warning that a turn has gone quiet
waiting for an answer.

**Four voices, four faces in the transcript.** The agent speaking and the
agent running a command were both `⏺`, so at a glance they were the same row;
tools now take `◆` and speech keeps `⏺`. Your own messages were `>` with the
text dimmed — the faintest thing on a screen you scan to find them — and are
now `▌` in the accent colour, in bold.

**Plan windows have bars.** `5hr █░░░ 16% · Week █░░░ 8%`. The number stays,
because a short bar cannot be precise and three numbers cannot be taken in at
a glance. The bar lights its first cell for any use at all and holds its last
back until the window really is full, so neither end of it lies, and it is
dropped on a narrow terminal rather than crowding the line beside it.

**Fixes.** A directory beside your home folder was renamed on screen —
`/home/adamant` drew as `~mant`. `/plan` was swallowed by the terminal
instead of reaching Claude Code. `/attach ~/file` looked for a folder
literally called `~`. And `--model` inherited the previous model's fast mode
and effort instead of starting the named one plain.

## What's new in 2.6.0

The terminal app remembers what you chose, offers your own skills, and lets
you choose where to work from a list.

**It opens as you left it.** The account, model and permission mode you last
chose are what the next launch starts in, so setting them is work you do once
rather than at every launch. `--profile`, `--model` and `--mode` still win: a
flag is what you say when you mean this launch, not from now on. The model is
remembered per account, because a model belongs to the provider that named
it.

**Your skills are in the `/` menu.** They always reached the model, but the
menu did not know them until after your first message — the list arrived only
with a run. It is now read up front through the same channel a run uses,
remembered per account and directory, and drawn with the first frame. A
bridged skill is found by the name you would think of, so `/code-review`
finds `artemis-skills:code-review` without your knowing which marketplace
owns it.

**Choose where to work from a list, not a path.** `/cwd`, and a new
"+ in another folder…" row at the top of the rail, offer the folders you have
already worked in — newest first, with the one you are in marked "here" — and
a browser for one that is not there yet. The browser walks the filesystem a
directory at a time; the first row chooses where you have arrived, so
accepting a folder is Enter. Long lists scroll instead of running off the
screen.

**Archive and delete from the rail.** `a` archives the selected conversation
and `d` deletes it. Archiving writes the same tag the desktop reads, so a
conversation put away in either is put away in both, and it moves to an
archive folder at the foot of the rail. Deleting destroys the transcript, so
it asks first.

**A folder with nothing in it is no longer drawn.** Including the one you are
standing in — a heading over no rows promised contents it did not have.

## What's new in 2.5.0

Artemis runs in the terminal.

**A terminal UI, installed with one command.** `artemis-tui` is the same
engine, the same signed-in accounts and the same permission controls as the
desktop app, with no window: a full-screen terminal app in the shape of the
provider CLIs. A rail on the left lists every conversation across all your
accounts, grouped by project with worktrees folded into their repository;
`/profile`, `/model` and `/mode` switch account, model and permission mode;
`/resume`, `/attach`, `/tasks` and `/usage` cover the rest, and `--print`
runs one turn for scripts. The line under the composer says what the next
message goes out as, with the 5-hour, weekly and Fable windows at its right.
Every release now ships a self-contained build for macOS on Apple silicon and
Linux on x64, and this installs it:

    curl -fsSL https://raw.githubusercontent.com/seth-torrence/artemis/main/install.sh | bash

It keeps a Node runtime beside the build when the machine has none new
enough, and never touches the system's. `artemis-tui --update` moves to the
latest release, and an installed copy checks once a day whether there is one.
Accounts come from the desktop app: sign in there, and the terminal has them
the same minute.

**Codex accounts get the 5-hour and weekly rings.** Codex describes its rate
limits by duration rather than by name, so the status bar's meter matched
neither and fell back to a single ring under a label like "5 hours". A window
five hours long is the 5-hour limit and one a week long is the weekly; they
now read as `5hr` and `Week` beside a Claude account's, in the desktop and in
the terminal alike.

## What's new in 2.4.8

Permission modes, and two ways they quietly did not take effect.

**Switching a conversation to bypass permissions now works.** It did nothing
before: the chip changed, the process did not, and every tool call went on
asking — including on the next message, because Artemis keeps the CLI warm
between turns and the same process served that one too. The mode needs an
opt-in that can only be given when the process starts, so a conversation begun
on any other mode has a CLI that will refuse the switch for as long as it
lives. Asking for it now starts a fresh one on the same conversation. A
conversation still running background work says so instead, and leaving bypass
for a stricter mode keeps the process it has.

**An Artemis server stops offering a mode it cannot honour.** A server running
as root cannot serve bypass permissions at all — the CLI refuses the flag
there — so its published capabilities no longer claim otherwise.

**"Allow for this session" works against a server.** The rules a run suggests
are usually written to last, which a connection token cannot do on someone
else's machine, so the whole answer was refused and "Approve once" was the only
one that ever landed. Suggestions are now narrowed to the run, and the parts
that cannot cross at all — changing the run's mode, widening its directories —
are dropped rather than sent to be refused.

## What's new in 2.4.7

Everything here is about working against an Artemis server, and about one
thing: the desktop could not see what the server already knew.

**A failed remote run says why.** It used to end with "The remote run failed.
The server reported the detail in the reply text, when it had one" — and there
was never one, because a run that fails before it generates has no text. The
server had the reason all along and dropped it on the way to the wire, so a
signed-out account on the far end and a refused model looked identical, and
both looked like nothing. The reason now travels with the failure and is what
you see.

**The server says it too.** A failed run is written to the serving machine's
log, naming the route: the reason used to travel only away from the one machine
that could act on it, so a server whose account had stopped working had no way
to mention it.

**Accounts on a server show their real sign-in state.** Every one of them
offered "Sign in again" and a model count, whatever shape it was in — an
account created and never signed in looked exactly like the ones that worked.
Rows now say signed in, signed out, or that the check itself could not be read,
and an older server that cannot be asked says that rather than guessing.

**A server's accounts are grouped by provider**, the way local accounts always
have been — Claude, Codex, a local runtime — instead of one flat list. A server
holding one provider is unchanged, and so is one too old to say.

## What's new in 2.4.6

Two fixes. Install this one if you are on 2.4.2 or later.

**Settings opens again.** Opening Settings could blank the entire window —
not the pane, the whole app, with no error anyone could read. The Models pane
read its shortlist through a store selector that built a new empty list every
time it was asked, and React eventually gave up and unmounted everything. The
trigger was the most ordinary state there is: an account that has never
pinned a model. If you had pinned one, you never saw it, which is how this
survived four releases — it has been in every build since 2.4.2.

**A model the account offers stops disappearing.** While a new model is
rolling out, the provider does not answer the same way twice: asked four
times in a row, the same account returned the old Fable and then Fable 5.1
three times. The picker took whichever answer arrived last, so a model could
be there, then gone after something incidental refreshed the list. A live
answer now only ever adds — the list keeps the provider's own order, and
anything it offered earlier and forgot this time is carried along behind it.
A model genuinely withdrawn is gone at the next launch.

Also: the bundled Claude CLI moves to 2.1.258.

## What's new in 2.4.5

One change, to the thing you spend the most time looking at: the model's
reasoning in the transcript.

**A stretch of thinking is one passage.** A working turn thinks, runs a tool,
thinks again — and the tool calls collect in the marker at the foot of the
run, so what was left in the thread was a dozen folds in a row, each holding
a sentence of a single train of thought. They are now one block, split into
paragraphs where the model paused, and what ends it is the agent actually
saying something. Reasoning still keeps its own row when a redaction breaks
it, and a subagent's working-out is never folded into the main agent's.

**It is rendered, not spelled out.** The model writes its reasoning in
markdown most of the time, and you were reading the asterisks. Bold, headings,
lists and code now render — but only for a block that genuinely is markdown,
so the paths, `snake_case` and pasted output in ordinary reasoning are left
exactly as written. The collapsed one-line preview drops the syntax too.

**It reads in the thread, not beside it.** The rule down the left, the indent
and the small italic are gone. Reasoning now sits on the same left edge and at
the same size as everything else in the conversation, one colour down — the
label in the gutter is what tells you it is not the answer.

Turn it on, if it is not already, in Settings → Appearance → "Show the model's
reasoning".

## What's new in 2.4.4

Bug fixes, all in the seams between a desktop and the accounts an Artemis
Server serves — plus the one that kept Windows machines out entirely.

**Remote sessions start from Windows.** They never reached the server: the
desktop demanded the *local* disk contain the server's working directory
before it would ask the server anything, and on Windows the server's
`/work/app` reads as a path on the current drive that does not exist. A
session run elsewhere never needs a local directory, so the check no longer
applies to it — and a run posted to a server with no usable directory of its
own now roots at the connection's pinned workspace instead of being refused.
Typing a server path into the directory field on a Windows machine also
stopped being rejected for having the server's own shape.

**The usage rings work at a server.** The bottom-right meter used to say a
server profile "does not report plan usage" while the server was reporting
it for every account it serves. The rings now follow the account behind your
current pick, refresh on demand, and the same reading gates each model row.

**Percentages are percentages again.** The account picker and the server
profile card could read 1100% — the server already reports 0–100 and two new
display sites multiplied by 100 again. Both fixed.

**The profile chip names the account.** At a server it used to say only
"Artemis Server"; it now says which account is about to be charged —
"Artemis Server — work max".

**One account's models, once.** With two Claude accounts served, every model
appeared twice with nothing to tell the rows apart. The model column now
narrows to the account picked above it; the search still reaches everything
the server serves, and rows found in another account wear that account's
own gauge.

**The embedded browser stopped impersonating yours.** Asked to open a page
"in my Chrome", an agent could drive the embedded dock tab and assure you it
had used your browser. The embedded tools now tell the model exactly whose
browser they are — and what to offer instead: "Browse with your Chrome"
(Claude sessions on this machine, via the Claude in Chrome extension) or
"Open pages in your default browser", both under Settings → Permissions &
access. If the extension does not connect on the first Chrome-enabled run,
restart Chrome once and approve the connection when it asks.

Also: the run location row says "This PC" on Windows instead of "This Mac".

## What's new in 2.4.3

One fix, on Windows only — and it is the one that stood between a Windows
machine and every other fix reaching it.

**Checking for updates works on Windows.** Since 2.3.0 every check there has
answered "The update feed could not be reached", on machines that had just
reached it. The feed was downloaded, parsed and compared correctly each
time; what failed was the tidying-up afterwards, which reached for a program
that only exists on macOS and took the finished answer down with it. The
symptom was doubly misleading — the one thing named as the cause, the
network, was the one thing that was working. Windows installs could only be
updated by hand, and every check left another directory behind in `%TEMP%`.

Cleanup now uses what the platform actually has, and a check that has read
the feed can no longer report otherwise because clearing up after itself
went wrong. The `%TEMP%` husks stop accumulating; existing ones are yours to
delete.

**Installing 2.4.3 on Windows is still a manual step.** The updater doing
the checking is the one already installed, so 2.3.0, 2.4.0 and 2.4.2 cannot
fetch their own fix — download the setup exe from the releases page once
more. From 2.4.3 onwards the card appears on its own, as it always has on
macOS.

## What's new in 2.4.2

Fixes for how a served Artemis behaves — the server profile now does what it
always looked like it should.

**Archiving a conversation on a server sticks.** The tag was written and
reported successfully, and the next listing showed the conversation live
again: the wire had no field to carry it home. Deleting only looked like the
working verb because deletion shows in a row's absence, and a tag only in
its presence.

**The permission-mode picker works on server profiles.** The mode rides the
wire as a request; the server honours what the serving provider supports and
drops the rest, and an older server drops the field — both land in the old
behaviour, the serving user's setting.

**Every served account reports its usage.** One gauge per account, from the
server's own short cache, in the server card and on the picker's account
rows — where before the accounts behind a server had no numbers at all.

**The picker treats a server as a place, not an account.** With a server
configured, the account column starts with Where — This Mac, or the server
by name — the server leaves the local account list, and at a server the
column shows its accounts with their gauges. The choice is sticky: it seeds
every new session until changed, outranks the local recommendation, and
falls back cleanly when the server is gone. Leaving returns to the local
account that was left.

**The quick-access curator reaches every profile.** Settings → Models gains
a profile switcher, fixing a curator that only ever showed the active
profile's models — 'only claude models', for anyone whose active profile was
Claude.

**A Codex sign-in on a server completes.** Its login serves OAuth on the
serving machine's own localhost, an address that was only true there; the
printed URL now works verbatim in your browser, forwarded over the
authenticated wire to where the CLI is listening.

## What's new in 2.4.0

**Your window hears its runs again.** The one-line bug behind a day of
"something is super slow": a cancelled navigation — clicking a link the app
reroutes to your browser — wiped every live-event subscription, and the whole
window fell back to the stall watchdog's 15-second replays. A 2-second turn
sat on "starting the provider" for half a minute with its answer already in
the window. The cleanup now runs only when the page is genuinely going away.

**A conversation on the server is yours to tidy.** Rename, archive and delete
work on an Artemis Server profile now, one route each, scoped by the server's
ledger to the sessions your token can already see. A deletion is a real one,
and it leaves an attribution line naming the token that asked.

**A serving account is managed from the server card.** Rename it (routes move
with it, and the card re-reads the catalogue), remove it (a second click,
with a sentence naming what goes and what stays), and for endpoint providers
set the address and key from here — the key travels one way and is never
echoed back. The add form gains a provider picker: Claude and Codex go
straight into their login, llama.cpp, LM Studio and Ollama into the address
form, because they have no login to run.

**The queued badge clears when the message is read.** Current CLIs fold a
queued message in without a word on their stream; the adapter now reads the
fold from the session transcript — the one place it is recorded — and the
badge clears at the moment of reading instead of the end of the turn.

**The busy banner names the holder.** A conversation held by background work
says "waiting for this conversation's background task to finish" instead of
claiming a turn is being finished that nobody can see.

**And the log grew eyes where it was blind.** `run.requested` lands before
credential resolution, and `run.started` carries `resolveMs` — so the next
slow start is attributable from one line instead of a day of forensics.

## What's new in 2.3.0

The reunification release: everything the david-systemtech fork learned comes
home, plus a day of fixes found in the porting.

**Windows is a platform now, not a port.** The sign-in command shown is one
PowerShell can actually run, npm-installed `.cmd` tools launch, the profile
farm links with junctions instead of privileged symlinks, shared Claude config
works (junctions and a hard link, re-runnable, nothing deleted), the whole test
suite runs green there — and CI defends all of it on every PR. Windows also
updates itself now: the NSIS installer is parked and run silently on restart,
from the same feed macOS reads.

**Linux releases what the config declares.** AppImage and deb ship beside
pacman, and the AppImage boots in CI before it ships.

**Settings → About.** The running version with a copy button, the platform and
channel, and a Check-for-updates that answers with one of five honest outcomes
instead of a spinner.

**Memory banks catch up.** Join a team bank from your own git URL — Verify
answers ok / auth-required / not-found / unreachable before anything is
written, and a private repo's token lives in the child's environment for
exactly as long as git needs it. The built-in prompt is editable, names your
actual bank, and previews exactly what a run will carry. Banks can mirror
read-only trees, grouped by organization and project. Every run reads the
enabled banks automatically — the sandbox learned read-only roots beyond the
working directory — and a stray file the old CLI never saw warns instead of
silently breaking background sync forever.

**A key manager can hold the secrets.** OpenBao and Doppler, side by side, as
many connections as you need. Private-CA servers are trusted by explicit
click on a fingerprint, pinning the issuer so certificate renewal doesn't break
the connection. The one stored secret is the manager's own token; passwords are
spent on login and never written.

**The server earns its keep.** The Docker image builds again (it could not),
survives deployment (its imports resolved into a stage that no longer existed),
and refuses to ship without its agent binary. A server's provider accounts can
be signed in from the desktop — the container never needs a shell — gated by a
grant absent by default, invisible without it. Served runs stop auto-denying
permission prompts: the ordinary permission card draws for a run happening on
another machine, and a dropped connection parks the run for six hours instead
of killing it. Tokens with an expiry now expire on the headless server too.

**And a day of fixes.** A message sent mid-run survives a reload, and the
interrupt it raced. The usage meter counts down between readings, and a stale
reading can no longer drag it backwards. A conversation forks without waiting
for the agent to stop. The queued-message banner clears the moment the agent
actually reads the message — and the message itself says "Queued" beneath it,
with an interrupt button to have it read now. The first pane in a split keeps
its conversation's name instead of claiming "New session". And thinking renders
for Claude and Codex, not just local models.

## What's new in 2.2.0

**Hand off.** A conversation can now be handed on deliberately, from a button
beside the working directory rather than only when a plan limit forces it.

- **Hand off to another account.** The conversation moves intact — transcript,
  directory, history — to any account that can read it. The same picker the
  automatic hand-off opens, with live meters on every row and blocked accounts
  shown struck through with the reason rather than hidden.

- **Or to an account that cannot read it.** This is the boundary the feature
  used to stop at: a session only resolves under the profile whose config
  directory holds its transcript, so accounts on the other side — a different
  provider, usually — were left out of the picker entirely. They are now
  offered the other act. The agent writes a briefing, and when it finishes, a
  fresh conversation opens on that account in the same folder with the briefing
  as its inheritance. It does not send itself: starting a paid run on an
  account you were only pointing at is not a decision the app should make for
  you.

- **Or just the document.** A hand-off briefing written and nothing moved, for
  when the next session is a person or a tomorrow.

  It lands in the **project**, never in a linked worktree. A worktree is made
  for one branch and deleted when that branch lands, so a briefing written into
  one disappears along with the work it was describing.

Every path stops a running agent first. Handing a conversation over — or
writing a summary of it — while a run is still appending to its transcript is
how two runs end up writing the same file.

**And a hover that was never there.** The colour used for "the thing under your
pointer" was the same colour as the menu it sat on, so menu items simply did
not respond — everywhere except the two surfaces that happened to define their
own. Every menu in the app answers the pointer now.

## What's new in 2.1.2

**Install this one.** It is the release that moves your copy onto the
repository's real home.

Artemis moved from the Rx-Ventures organisation to `seth-torrence`. GitHub
kept a redirect, so nothing broke and nothing looked wrong — but every copy
installed before this one is still asking the old address where to find its
updates, and a redirect is not a promise. If anything is ever created at the
old path, the redirect stops and those copies go looking somewhere nobody
controls.

Updating to 2.1.2 settles it permanently: this build carries the real
address, so from here on your copy asks the right repository directly. There
is nothing to do beyond installing it, and no further migration after this.

If auto-update is switched off, take this one by hand — it is the last
release the old address will reliably reach.

## What's new in 2.1.1

2.1.0 changed the tokens; 2.1.1 finishes the overhaul the tokens started —
every surface, judged against the fine-tuned design and against the running
app itself, iterated live until the two matched.

- **The shell is cards on a canvas.** The sidebar, every conversation and
  the dock are detached rounded panels on the darker window ground, with the
  resize seams living in the gutters between them. The dock floats with no
  border and no inner wall; the focused conversation carries the accent on
  its own edge in a split.

- **The dock offers its six kinds.** The strip stops being a list of what
  happens to exist: terminal, browser, working folder, delegated work,
  subagent output and preview are always drawn, live instances light their
  slots, and the four that can be opened open on press. The other two are
  shown disabled with their reasons. The terminal panel wears a proper
  header — what it is, and whether it is alive.

- **The picker matches its design.** Profile / Model / Effort as titled
  columns, the recommendation worn as a small pill on the row itself rather
  than a label row above it, and the surface anchored where the hand is —
  above the chips that open it.

- **Exact measures, everywhere.** The transcript on the design's 920px
  column at its 12px rhythm; composer, status line and messages on one
  shared measure; session rows carrying their age again; palette, settings
  and hand-off dialogs at their drawn sizes; the chrome voice in sentence
  case throughout.

- **Small honest fixes along the way.** A failed tool card no longer loses
  its red edge when expanded, the slash menu's highlight is visible again,
  and the long-dead update card left with its tests.

## What's new in 2.1.0

The console treatment. 2.0 settled what Artemis's colours are; 2.1 settles
what its surfaces feel like — judged the same slow way, against a control and
two brackets, on every screen the app has (design record: rounds six and
seven, `docs/design/`).

- **Rounded, quieter, same density.** The 3px radii become 8px, and the app's
  chrome voice drops the uppercase monospace for the sans in sentence case.
  What dated the window was never its compactness — it was the terminal-
  emulator costume. The grid still fits four conversations; they just stop
  looking like instrument panels.

- **One column, three surfaces.** The transcript, the composer and the status
  line now share a single measure. The input and the chips under it used to
  pin themselves narrower than the messages above them, so nothing lined up
  and the drift grew with the pane. The profile, model, mode and sandbox
  chips — and the usage rings — end exactly where the conversation does.

- **The header earns its middle.** Search sits centred on the window at real
  width, with the way in (`⌘K`) printed on it. The four surface buttons —
  terminal, browser, folder, delegated work — fold into one opener menu that
  also carries both splits and New session, each row teaching its shortcut.
  Settings and the theme control keep their corner.

- **The sidebar toggle has one home at a time.** The 46px navigator rail is
  gone; its icons were doubles. The list's own caption closes it, and while
  it is closed the header — the one strip that never disappears — shows the
  way back. `⌘B` works in both states, as before.

- **The dollar signs are gone.** Model rows in the navigator, the palette and
  settings no longer price a choice in `$` pips and multipliers. The pressure
  dot and the plan meters stay — they are facts; the pips were an opinion.

- **A conversation crossing providers leaves its model behind.** Clicking
  from an OpenCode session into a Claude one used to carry the selected model
  id across, and the next prompt would hand a name like `luna` to a CLI that
  has never heard of it. On a provider change the whole model choice — model,
  effort, fast mode, ultracode — now resets to the arriving provider's
  default, unless the conversation itself remembers what it last ran on,
  which still wins.

## What's new in 2.0.0

Artemis 2.0. One overhaul, shipped whole: how the window looks, how you pick
what runs, whose dock it is, and where a conversation can go when its account
runs dry — or when the machine doing the work isn't the one you're sitting at.

- **A new coat of paint, chosen the slow way.** The near-black canvas is now a
  bare neutral grey, and the bright teal accent is a deep blue-violet fill you
  sit things on rather than an ink that glares. Both were judged against
  control renders across five mockup rounds, and the light theme was settled
  the same way — derived from the same two seeds as the dark one, so the two
  read as one system instead of cousins.

- **The profile and model chips open one navigator.** Profile → Model → Effort
  as columns that reveal left to right, and every row knows what it costs you:
  live usage meters and reset times per profile, a relative burn-rate pip per
  model (Fable draws 8× what Sonnet does against the same plan), and a model
  whose weekly window is spent stays visible — struck through, with the reason
  and when it comes back. A Recommended row points at the account with real
  headroom, so the right choice is the easy one.

- **The dock belongs to the conversation.** Surfaces — terminals, browsers,
  previews, files — are owned by the conversation that opened them, shown for
  the pane you're focused on, with an explicit toggle to see everything. Four
  identical terminal icons from four panes are gone; tabs say whose they are.
  Preview is no longer a window-wide singleton, file tabs distinguish the one
  you're reading from the ones you've pinned, each session's arrangement comes
  back when that session does, and a terminal selection can be sent straight
  into the conversation's draft. The old rule survives everywhere: only the ✕
  ends a shell.

- **When an account runs out, the wall is a menu.** Hitting a limit used to be
  a dead end with generic advice. Now the banner names the window that tripped
  and when it resets, and — when another signed-in account can take the work —
  offers to continue there. At the automatic threshold, a picker shows every
  candidate with its live meters and you choose. Nothing ever moves without
  you choosing it; when no account can take the work, the continuity note
  still gets written.

- **The same window reaches another machine.** Point Artemis at an Artemis on
  another computer — over your tailnet, with a token you carry by hand and can
  give an expiry — and the window you already know becomes the remote one:
  watch its runs live, interrupt them, answer their permission prompts, start
  new work, open its shells. Tokens are workspace-pinned and account-scoped,
  revocation cuts even an open stream within seconds, and everything a remote
  hand does is written to a log the serving machine keeps.

- **Runs stopped lying about their lifecycle.** The five reported bugs are
  fixed: sessions that silently detached after an app restart, Codex refusing
  follow-ups on resumed conversations, the stop button not acknowledging the
  click, a vanished transcript pretending to be a new conversation, and rival
  runs racing one session. Underneath, Artemis now keeps a session-lifecycle
  log — run started, ended, adopted, released, ids only — so the next incident
  is read rather than excavated.

- **Settings sorted by what things really are.** Two bands — what Artemis is
  for you, and how it runs — with agents and memory banks merged into
  Instructions, a new Runs section, and stable deep links throughout.

## What's new in 1.16.0

Slash commands read as commands instead of as markup.

- **A slash command is one line, not two bubbles of XML.** Running `/model` or
  `/effort` used to put the CLI's own markup straight into the transcript —
  `<command-name>`, `<command-args>`, `<local-command-stdout>` — as two
  full-width chat bubbles, plus a third message of boilerplate addressed to the
  model. Artemis now recognises all of it and draws one compact row: the
  command, its arguments, and what it printed. The boilerplate is dropped, and
  terminal colour codes no longer show up as escape sequences on screen.

- **It is no longer filed as something you said.** `/model` never reaches the
  model — it changes the session and prints a line. Drawing it in your own
  message bubble made a settings change look like a turn in the conversation,
  so it now sits in the same quiet register as the rest of the session record.

- **Commands that print nothing still appear.** A plugin command that expands
  into a prompt rather than doing something locally leaves no output, and used
  to leave no trace either — so the turn that followed had no visible reason.

## What's new in 1.15.0

The usage meter now hears the provider's own verdict, so an account that is
out of usage says so — even while its percentage still reads 97%.

- **"Says 97% but I'm out" is fixed.** Claude states on every response whether
  the account is allowed, near its limit, or being refused. Artemis used to
  drop that signal and show only a polled percentage, which lags by minutes
  and rounds away the endgame. The verdict now reaches the meter live: a
  refused window draws full and red, reads "limit reached — requests are being
  refused", and says when it comes back. Between polls, the rings move within
  seconds of the provider deciding, not minutes after.

- **The profile menu says "out".** An account the provider is refusing shows
  `out` where its stale percentage used to be, and the recommended-account
  ranking scores it at zero headroom — it can never be the account Artemis
  sends your next session to.

- **Automatic handoff fires on the refusal itself.** A refused window triggers
  the handover below its percentage threshold, so the weekly rule at 98% no
  longer sits silent while an account reported at 97% is already turning
  requests away.

## What's new in 1.14.1

Artemis now ships for Arch Linux, keeps live Codex conversations attached, and
never silently substitutes a different model for the one you chose.

- **Arch Linux gets a native package.** Releases now include an x86_64 pacman
  package alongside the Apple Silicon macOS and Windows x64 installers. The
  Linux build runs and boots on a Linux x64 runner before it is published, just
  like every other platform artifact.

- **A live Codex conversation stays live in its pane.** A window could lose its
  binding to a Codex run that was still advancing, show the conversation as
  idle, and try to start a rival runner on the next prompt. Artemis now recovers
  that binding from the engine's live registry, restores the event stream, and
  routes prompts and steering back to the run that already owns the session.

- **Your pinned model remains the model on the wire.** The built-in and live
  Claude catalogues use different ids for the same models. Before the live list
  arrived, a saved id such as `opus[1m]` matched nothing and silently fell back
  to the first built-in model, so the next prompt could run on a model nobody
  chose. An unmatched saved id now passes through unchanged until the live
  catalogue reconciles it.

## What's new in 1.14.0

Messages sent while the model is working now reach it, conversations keep
moving without a refresh, and the suggested reply is something you can edit.

- **A message sent mid-turn is no longer lost.** Typing while the model was
  working showed the message as sent, and more often than not nothing ever
  came of it. The provider folds a mid-turn message into the running turn
  only at a pause between tool calls; a message that missed every pause was
  queued as the *next* turn — and Artemis shut the conversation down at the
  end of the current one, taking that queue with it. The queued turn is now
  served, and it continues the same conversation.

- **"Read it now."** While messages are waiting, the composer says how many
  and offers to interrupt so the model reads them at once rather than at the
  next pause. Interrupting keeps the queue rather than discarding it, which
  is what the notice after a stop always claimed and did not do.

- **Conversations keep updating without ⌘R.** A conversation that was
  working could open frozen and stay frozen — a whole class of causes, all
  ending the same way: a turn started somewhere the window could not see (a
  schedule firing, another window, the server), events arriving for a
  conversation no column held, and the machinery meant to notice being
  disarmed by those same events. Opening a working conversation now attaches
  to it, a stalled column is spotted wherever it is, and a window that
  cannot reach the run registry at startup says so instead of quietly
  stranding every conversation until the next restart.

- **The suggested reply is a draft, not a button.** It appears as grey text
  inside the composer — Tab to accept, then edit it like anything else you
  typed, or keep typing to dismiss it.

## What's new in 1.13.1

Three fixes to conversations you come back to — when they happened, whether
they are still working, and where they open — and local models finally
remember what you said to them.

- **A reopened conversation shows when it happened.** Every line of a
  replayed transcript carried the moment you reloaded it rather than the
  moment it was written, so a session from last week read as having
  happened entirely just now. The times were on disk the whole time —
  Artemis was stamping its own read time over them.

- **The sidebar stops calling finished conversations "working".** A
  conversation that had ever set up a schedule — a `/loop`, a routine, any
  wakeup — was marked as working from then on, however long it had been
  idle, so the list filled with spinners for sessions that opened plainly
  done. Artemis keeps such a conversation's process alive on purpose
  (nothing says when the next wakeup lands), and that was being shown as
  activity. Now the marker means what it says: a turn in progress, work in
  the background, or a task settling. A turn started by a schedule while no
  window was watching now marks its session too, which the old reading
  could not see at all.

- **A conversation opens at its end.** Reopening a session dropped you
  partway up it, with a scroll to the bottom to do by hand. Two habits made
  it worse: scrolling up to read something stopped the transcript following
  its tail, and that carried into the *next* session you opened; and a
  session's history arriving in bulk made the follower conclude you had
  scrolled away, mid-load. Opening a conversation now starts at its end,
  and following stops only when you actually scroll up — with the tail
  picked up again the moment you return to the bottom.

- **Local models keep their conversations.** A local provider was sent only
  your latest message, so every turn began a fresh conversation with a model
  you believed was following one — and local sessions could not be listed or
  resumed at all, because none of it was ever written down. Each conversation
  now keeps a transcript on disk, is seeded with it on every turn, and shows
  up in the sidebar to reopen like any other. Rewinding and forking a local
  conversation stay unavailable.

## What's new in 1.13.0

Cerebro grows into memory banks: any git repository can be one, and a
machine can carry several.

- **Bring your own memory bank.** The team-memory feature no longer assumes
  the one team repository. Settings → Memory banks joins a shared bank from
  any git remote, creates a fresh local-only one (no remote, no account —
  memories land as plain commits), or adopts a folder that already is one.
  Artemis ships the bank CLI for the machine that has none yet; a bank
  created here embeds its own copy, so the repo stays shareable with people
  who do not run Artemis.

- **Several banks at once, each in its own lane.** Every bank is registered
  under a short name and installs into project memory in its own directory
  behind its own markers, so a team bank, a personal bank, and a client's
  bank coexist without treading on each other. Agents are briefed per
  machine: the prompt names your actual banks, which one takes new facts,
  and how to route a fact to a different one.

- **Banks you read but never write.** A bank can be registered read-only —
  its memories inform every session, and drafting, promoting, and retiring
  into it are refused everywhere: the CLI, the sync cycle, and the pane.
  That is the shape for subscribing to a bank someone else owns.

- **Nothing moves for existing setups.** A machine already running Cerebro
  is registered automatically under its old name, keeps its exact install
  layout, and keeps its yes: if the bank was on, it stays on. The one
  visible change is the pane's name.

## What's new in 1.12.0

A connection token can no longer reach conversations that are not its own,
and a server profile shows you its history.

- **Sessions on the server are scoped to the token that made them.** If you
  run Artemis's server, a program holding one of its connection tokens could
  previously continue *any* conversation stored in the directory that token
  was pinned to — including conversations you had yourself, in the app, in
  that folder. It only had to name one. That is closed: Artemis now records
  which connection created each server conversation, and listing, reopening
  and continuing all check it. Your own conversations were never recorded
  there, so they are not merely refused — they are unreachable. Two tokens
  pinned to the same folder still share their history with each other, which
  is what makes one person's several machines one workspace.

- **A server profile lists its conversations.** Point a profile at another
  Artemis and its sidebar fills in: the conversations that connection has
  had, openable and continuable from here. Before this, a server profile
  could carry on the conversation in front of you and nothing else — close
  the app and the thread was gone. Now every machine holding the token sees
  the same history, which is the point of pointing two laptops at one
  server.

- **Artemis can run without a window.** New in the repository rather than in
  this download: a headless build that serves the same HTTP surface from a
  plain Node process, and a container to put it in. Sign an account in
  inside the container, mint a token per machine, and the conversations
  follow you between them. `docker/docker-compose.yml` holds the whole
  procedure in its comments.

## What's new in 1.11.0

The update you are offered is the one that exists now, rather than the one
the notice remembered, and releases stop building for Intel Macs.

- **Updates no longer get stuck on a version.** An offer used to be made
  once and then believed forever. A copy running 1.10.0 that was offered
  1.10.1 went on being offered 1.10.1 after 1.11.0 shipped — and went on
  downloading it, too — because the notice was already up and nothing ever
  revisited it. The only way out was to dismiss it. Clicking **Update now**
  now re-reads the release feed before it fetches anything, so what installs
  is the newest release at the moment of the click. *Check for Updates…* and
  the four-hourly background check do the same, replacing what is on the
  notice with what the feed says now, and a notice for a release that has
  since been pulled comes down on its own. When the feed cannot be reached,
  whatever is on screen is left exactly as it was: a check that fails
  changes nothing.

- **Intel Macs are no longer built.** Releases ship for Apple Silicon and
  Windows. An installed Intel copy keeps working and simply stops being
  offered updates — it polls a feed that is no longer published, finds
  nothing, and stays where it is. The build matrix entry is preserved at the
  v1.10.0 tag if an Intel machine ever matters again.

## What's new in 1.10.0

The composer suggests what you might say next, a message you send appears
once, and rewind and fork finally do what they say.

- **Suggested next prompts.** When a turn finishes, Claude predicts what you
  are likely to ask next and offers it above the composer. Click it — or
  press Tab from an empty field — and the text lands in the draft, yours to
  edit or send. It is never sent for you: it is a guess at *your* next
  message, which makes it an offer rather than an instruction. The
  suggestion retires itself the moment the next turn starts, and the
  provider skips predicting after plan-mode turns, failures, and the first
  message of a conversation.

- **A message you send appears once.** Sending a message could show it
  twice, with a reload collapsing it back to one. The window heals a lost
  stream by replaying what the engine retained — including your own prompt —
  and that replayed copy had no way to recognise the message already on
  screen, so it drew a second one. Your messages now carry an identity from
  the moment you send them, and a re-delivered copy merges onto the row you
  are already looking at. The same fix restores something that healing used
  to quietly lose: a recovered conversation keeps its session, model, and
  tool list instead of coming back anonymous.

- **Rewind and fork actually rewind.** Both controls under a settled message
  shipped in 1.9.0 and neither worked. "Rewind to here" cut the transcript
  on screen while the model kept every turn you thought you had removed, and
  "fork from here" branched the whole conversation rather than branching at
  that message — silently, in both cases. They work now: the message is
  located in the provider's own stored conversation when you click, checked
  against what is on screen, and nothing is cut unless the two agree. The
  controls are also findable — they appear under any settled message rather
  than only in reopened sessions, they explain themselves on providers that
  cannot rewind instead of vanishing, and the command palette carries
  "Rewind to your last message" and "Fork from your last message".

## What's new in 1.9.0

One Artemis can drive another, the app keeps its own appointments, and the
sidebar works from any account.

- **Point Artemis at another Artemis.** A new "Artemis Server" provider row:
  give a profile the serving machine's address and one of its connection
  tokens, and its accounts' models appear in your picker. Turns run *over
  there* — in the directory the connection token pins, with permission
  prompts declined because nobody is present to answer them — and the reply
  streams back here. Conversations continue across turns: the server keeps
  the session, which is the one thing a raw model endpoint cannot offer.

- **Routines — runs on a schedule.** Settings → Routines holds prompts with
  appointments: hourly, daily, weekdays, weekly, or a cron line, at
  one-minute resolution in your local time. Each firing is an ordinary
  conversation with a full transcript, billed to the profile you chose, and
  the sidebar's new Scheduled strip shows what is due next. Firings finish
  with a desktop notification; a due minute that finds the previous firing
  still running skips with a note instead of stacking a copy; and a machine
  that slept through an appointment fires the newest missed one — once,
  within seven days — when it wakes. Pause, run-now, and the last firings'
  outcomes live on each routine's card.

- **The sidebar works from any account.** Selecting a local-model profile
  used to disable every other conversation in the list — each row was asking
  the *active* provider for permission to resume, and a llama.cpp endpoint
  honestly answers that it cannot. Rows now answer to the provider they
  belong to, so a Claude conversation is clickable from anywhere, and a row
  that genuinely cannot be resumed names the provider that cannot do it.

- **Local server profiles say what is actually wrong.** The availability
  probe's sentence — "Nothing is answering at that address", "check this
  profile's API key" — now reaches the profile screen, where a bare
  "Unavailable." used to stand in for all of them.

## What's new in 1.8.0

The slash-command menu works at the start of a conversation, where you
actually use it, and the mark is the bow again.

- **Type `/` before you have sent anything and the menu opens.** It used to
  need a run first, so the first message of every conversation — the most
  likely place to reach for a command — was the one place nothing happened.
  Artemis now asks the provider what a session there would offer, on launch
  and whenever a column settles on an account or changes directory, so the
  list is waiting by the time you type. Costs no tokens: it is a control-channel
  question, not a turn.

- **The menu keeps up with the directory.** Commands are discovered relative to
  where the agent runs, so moving the working directory re-reads them rather
  than leaving the previous project's list in the menu.

- **The mark is the bow again**, in the current accent. The moon in a square
  frame was a near neighbour of every contrast and theme toggle ever drawn,
  which the frame alone was doing all the work to prevent. At the very smallest
  Finder and dock sizes the bow's string falls under a pixel and the mark reads
  as a bow without one; everywhere else in the app it is drawn well clear of
  that.

## What's new in 1.7.0

A conversation that goes quiet heals itself, and a local model server is
something you can actually point Artemis at.

- **No more reloading a stuck conversation.** The long-standing failure — a
  pane saying "starting", "thinking" or "running" forever while the agent had
  quietly finished, fixable only by ⌘R — is closed structurally. The window no
  longer trusts the live event stream alone: any conversation that looks busy
  but has said nothing for twenty seconds is checked against the engine, which
  always knew the truth, and healed from its retained events — the missed
  messages, and the real ending with the real reason. Worst case, a stuck pane
  now corrects itself in about half a minute, with nothing lost. A genuinely
  quiet stretch — a long command, a slow tool — is recognised as such and left
  alone.

- **llama.cpp, LM Studio and Ollama profiles have a server address and an API
  key.** Both fields live on the profile itself, visible and editable — the
  address used to be write-only and the key impossible. Any http or https
  address works: another port, another machine, a tunnel, a reverse proxy. The
  key is sent as a bearer token on every call, stored encrypted by the
  operating system, and never shown or sent anywhere but the address you
  typed. A server that refuses the key now says so, instead of claiming
  nothing is running. Profiles from older builds pick up their stored address
  automatically.

## What's new in 1.6.0

The plugins you install reach your sessions, and an update in flight says what
it is doing instead of spinning.

- **A plugin you installed from a marketplace shows up.** Install one with
  `/plugin install` and its skills and slash commands are on offer in Artemis —
  type `/` and they are in the menu, under the plugin's own name. They were
  never loading before, and it read as a broken menu rather than as a missing
  plugin, because the menu is exactly the list the provider reports. What was
  missing was not the files but the switch: a plugin is enabled by a key in
  `~/.claude/settings.json`, which is the layer Artemis deliberately does not
  read. That one key is read now, and nothing else in the file is. A plugin
  installed while a conversation is open appears in the next one.

- **The slash-command menu keeps up.** When the provider revises what it
  offers mid-session — a skill found in a directory the agent moved into, a
  plugin reloaded — the menu follows, instead of showing what was true when the
  session opened.

- **An update in flight says what it is doing.** Installing an update used to
  be a small spinner over one unchanging sentence, for minutes: around 196MB
  downloaded, checksummed and unpacked with nothing on screen to tell any of it
  from a hang. It names the step it is on now, with a real progress bar and a
  byte count, and the header chip counts a percent. Where a step genuinely
  cannot know its total, the bar says "still working" rather than inventing a
  position.

- **A determinate progress bar reads as one.** Every bar in the app was
  reporting itself to screen readers as indeterminate, whatever it was showing.

## What's new in 1.5.0

The agent can browse with your browser instead of its own, and the numbers
that hand work off a nearly-spent account are yours to move.

- **The agent can drive your own Chrome.** Turn on *Agent browses with your
  Chrome* in the new Settings → Browser pane and Claude conversations connect
  to the Claude-in-Chrome extension: real tabs in your Chrome, your logins,
  your password manager, a tab group beside the tabs you keep using. Artemis
  stops offering its embedded dock browser to those runs — two browsers
  answering the same questions from two different cookie jars is how an agent
  confidently reads the wrong one. It takes a signed-in profile and the
  extension installed; an API-key profile keeps the bridge off and the run
  simply browses with whatever it was given. One conversation drives the
  bridge at a time.

- **Pages can open in your default browser.** A second toggle, for a smaller
  preference: the agent keeps a way to *show* you a page, and the page lands
  in the browser you actually live in rather than the sandboxed dock tab. The
  reading and clicking tools that only make sense against a page Artemis owns
  are not offered at all — the agent is told to ask you what the page shows —
  and permission rules built under one mode survive the other, because the
  open tool keeps its name.

- **The handoff thresholds are yours.** Handing work over before the limit
  used to fire at fixed numbers. Each rule is a slider now, under Appearance →
  Handing over: 5-hour, weekly and Fable, each with its own margin, live in
  the label as you drag. Dragging a threshold under where the account already
  sits hands over immediately — you meant it to apply to the account you are
  looking at. A slider parked back on its default keeps following future
  releases' defaults rather than freezing today's number.

- **A model choice stays with the conversation it was made for.** Switch
  conversations, change the model there, come back: the first conversation is
  on the model you chose *for it* — effort, fast mode and ultracode included —
  not whatever the column last used. The record survives a relaunch.

- **A message to an idle conversation arrives.** Leaving a conversation idle
  long enough could swallow the next thing you said: a spinner over a message
  that went nowhere, or a reply that opened a fresh session under the old
  transcript. Four separate holes lined up behind that one failure — how long
  a finished conversation is remembered, what a locally-drawn end promotes,
  which state a retry reads, and a process dying at exactly the wrong moment —
  and all four are closed. A message that cannot be delivered now fails
  loudly and asks to be sent again instead of pretending it arrived.

- **Archiving a waiting conversation answers it.** A conversation archived
  while it sat on a permission prompt used to keep its amber "waiting" marker
  lit indefinitely — in the section whose whole meaning is "put away".
  Putting a conversation away is the answer: its parked prompts are declined
  on the way in, the run ends the way any declined prompt ends it, and the
  marker clears. Unarchiving restores the row, not the questions.

- **The effort ladder fits the window that has to show it.** On a small
  window the reasoning-effort submenu could clip off-screen; it now sizes
  itself to the space the window actually has.

## What's new in 1.4.0

A conversation can be wound back to something you said, and reopening one no
longer buries it.

- **Rewind, or fork, from any of your own messages.** Hover a message you sent
  and two controls appear under it. **Rewind** winds the conversation back to
  just before it: everything after is dropped and your words go back into the
  composer, ready to be said differently. **Fork** does the same to a *copy* —
  the original conversation stays whole and intact, and the new direction
  branches from that point.

  This is the thing to reach for when a turn went somewhere you did not want.
  Steering mid-run tells the agent to change course while it still carries every
  wrong assumption it just made; rewinding removes them from the conversation
  entirely, so the retry starts from the last point that was still right.

  Both need a conversation that is sitting still — the controls are absent
  during a run, because winding back work that is still happening is not a
  well-defined thing to ask for. They are absent on Codex too, which has no
  truncating resume to build them on.

- **A reopened conversation reads the way it did live.** Opening a session from
  the sidebar used to gather *every* tool call it ever made into one marker
  parked below the last message — an hour of work in a single line at the foot
  of the column, opened by default because something in it had failed, with the
  conversation itself scrolled off the top. Each turn's work now sits under that
  turn, exactly where it was while the turn was happening, and markers open when
  you open them. A failure still says so on the line, in signal, and it stays a
  line.

  Closing a marker also *stays* closed now when you leave the session and come
  back. It always claimed to; the ids it remembered them by never matched after
  a reload.

- **What you have typed stays with the conversation you typed it to.** Start a
  new session, type half a prompt, click another conversation to check something
  — the text used to follow you there, sitting in the composer looking like
  something you had written *there*, and it went there on Enter. Or vanished, if
  the conversation you clicked was one already running. Now every conversation
  keeps its own unsent text: switch away, switch back, and it is where you left
  it, in the right place.

- **`#123` is a link.** A pull request named the way people name one — `#141`,
  `owner/repo#141`, "see PR #98" — now links to it, with the same hover reading
  a pasted URL has had: whether it merged, whether its checks pass, how big it
  is. A bare number resolves against the repository your working directory
  actually pushes to, so it points where you mean; if that remote is not GitHub,
  nothing is invented and the text stays text. Numbers inside code, and inside
  links you already wrote, are left alone.

- **The effort menu opens onto the screen.** The thinking-level submenu inside
  the model picker opened leftward and off the side of the window, which made
  the levels unreachable at some window sizes.

## What's new in 1.3.0

The skills and slash commands you have already installed now work inside Artemis.

Artemis keeps your `~/.claude` out of its sessions on purpose — a third-party app
should not quietly adopt your hooks, your permission rules or your MCP servers.
That isolation was also hiding the things you *did* want it to have. A skill
installed months ago and a slash command you wrote yourself were sitting on disk,
correctly filed, and never once read: a session could see 46 slash commands where
the account had 49, and the three missing were yours.

- **Your skills reach both providers.** Anything in `~/.claude/skills` is offered
  to Claude sessions, and anything in `~/.codex/skills` to Codex ones. The
  vendor-neutral `~/.agents/skills` counts for both, so a skill installed once is
  available everywhere rather than in whichever half of the machine you happened
  to install it on. Nothing to enable and nothing to copy — install a skill and
  your next message has it.

- **Your slash commands work, and the composer finds them.** Type `/` and the
  commands available to that conversation are listed; keep typing to narrow it,
  Enter or Tab to accept. Your own commands arrive under a prefix —
  `/artemis-skills:cerebro` rather than `/cerebro` — because that is the only
  form the provider will honour, so the menu inserts the full name for you and
  you never type the prefix. Searching ignores it too: `/cer` finds it.
  Arguments work as they always have.

  The list also includes the commands the provider ships, like `/compact`, which
  have been available in every session all along with no way to reach them. It
  appears once a conversation has started, since it is the session that says what
  it accepts.

- **What Artemis still does not take is unchanged.** This is deliberately not
  "load the user's configuration". Skills and commands are documents; hooks,
  permission rules and MCP servers are not, and they stay out. The channel this
  is built on can only carry the two — not by a filter that has to be maintained,
  but because the folder Artemis hands the provider contains nothing else.

- **Codex has no slash commands to bring across.** Its `/` shortcuts belong to
  its own terminal interface rather than to your account, so there is nothing on
  disk to make available and the menu stays closed there. Its skills are covered
  above.

## What's new in 1.2.0

Artemis can lend its accounts to other programs on your machine.

Until now a profile was usable only from inside a window. **Settings → Server**
opens a local HTTP server that publishes them — every account, every model, and
what each model actually accepts — so an editor, a script or an agent can route
a turn through them. Point any OpenAI SDK at it and it works; nothing needs to
know what Artemis is.

It is **off by default and reachable by nobody** until you say otherwise. There
is no server-wide password. Starting it asks first, every time — this is not a
preference, it is lending programs the ability to spend your plans, and the
circumstances that make that reasonable differ each time it is asked.

- **A model is addressed as `profile/model`.** Two accounts can both offer Opus
  on different plans, so a bare model id names two things and Artemis would have
  to guess which one to bill. `work-max/opus` says which. The catalogue also
  publishes what OpenAI's schema has nowhere to put: which thinking levels a
  model accepts, and whether fast mode or ultracode reach it at all. A client
  that cannot see `fastMode: false` will believe a toggle took effect when the
  run ignored it.

- **Access is a connection, not a password.** Each one is a token bound, at the
  moment you create it, to where its turns may run: a folder you pick, a scratch
  directory Artemis creates and deletes, or nothing at all for a program that
  only reads the catalogue. That choice is fixed when the token is issued and
  never widens — re-scoping means issuing a new one — because a token whose
  reach can grow after you have handed it to a program is one nobody can reason
  about. You can narrow it further to named accounts and models, and revoking
  one connection leaves every other alone.

- **Turns run for real, whole or streamed.** A turn is not a completion, and
  three things follow from that. Nobody is watching an HTTP request, so a
  permission prompt is denied rather than left to hang — with a message written
  for the model, so it adapts instead of stalling. The agent's own file reads
  and commands are reported as activity rather than as tool calls no client
  could perform. And a client that hangs up interrupts the run, because
  otherwise the provider keeps spending your plan on output nobody will read.

- **Settings that cannot be honoured are refused, not ignored.** A request that
  sets `temperature: 0` is asking for determinism; answering it with a sampled
  reply and saying nothing would let someone build a cache or a test on a
  promise Artemis never made. Those parameters fail the request and say which.
  Labels that change nothing — `user`, `store` — are accepted and reported back
  as ignored.

- **Conversations a program starts stay out of your sidebar.** They are written
  to the provider's history exactly as your own are, under the account that ran
  them, so the record is intact if you ever need to audit what a program did.
  The history pane simply lists what *you* started — otherwise a script polling
  every minute would bury your own work within the hour.

## What's new in 1.1.1

Three fixes, all of them things that were quietly claiming something untrue.

- **An archive that stored nothing stops being reported as done.** Archiving
  moved to the provider's own record in 1.1.0, and the call that writes it can
  answer "found nothing to write to" — a success, in the sense that the caller
  asked about the state of the world and was told what it is, but a success
  that stored nothing. Both places that archive read only whether the call had
  failed.

  For the one-time migration that carried existing archives across, that was
  every archived session at once: it dropped each local record on an answer
  that had written no tag, and it is written to run only once, so it never came
  back to try again. An entire sidebar unarchived itself with nothing left on
  disk saying it ever had been. Archiving a single session had the same blind
  spot in miniature — the row would disappear and then return at the next
  listing with no explanation, which is the report that moved archiving to the
  provider in the first place.

  Both now check that something was actually written. A migration that could
  not write keeps its record and tries again next time; an archive that could
  not write puts the row back and says the provider has no record of it.

- **Local providers can be chosen again when making a profile.** LM Studio,
  Ollama and llama.cpp are meant to sit in their own half of the provider
  picker, selectable whether or not the server happens to be answering right
  now — a local profile is an address you are about to point somewhere, not an
  installation to be verified. The field that says which half a provider
  belongs to was never filled in, and an unset one means "hosted", so all three
  were filed under an account they do not have and disabled for not being
  signed in to it. There was no way to create a profile for any of them.

- **A Codex session says which branch it came from.** The second line of every
  sidebar row reads a branch off the session, and no Codex session ever carried
  one — not because the branch was unavailable, but because Artemis read the
  id, the directory, the name and the timestamps and stopped. Codex has
  reported it all along. Codex rows now answer the same as Claude rows, and stay
  blank only for a session opened outside a repository.

## What's new in 1.1.0

- **A reload stops hiding the work that is still running.** With subagents or a
  workflow going, reloading the window left the conversation looking finished:
  the delegated tab greyed out, the column reading as dead, nothing to reopen.
  The work was never interrupted — only the window's view of it — and sending
  any message brought the whole list straight back, which is a poor way to find
  out your workflow was alive the entire time.

  The rows were only ever announced on the turn that launched them, and they
  were retained only on that turn's own stream. A workflow routinely outlives
  the turn that started it by minutes, so by the time you reloaded there was
  nothing left to replay: the conversation was being served by a later turn that
  had never mentioned the work. Artemis knew the conversation was still busy —
  that is what kept the column from being thrown away — it just had no way to
  ask what it was busy *with*. It does now, and the rows come back on their own
  a moment after the window does.

  They keep arriving, too. A workflow that finishes while no turn is open used
  to leave its rows frozen mid-flight until something else opened one; they now
  settle on their own.

## What's new in 1.0.0

Version one. Three providers at a stated bar, a design language that is the
app's own, and both of those enforced by tests rather than described in
comments.

### Three providers, honestly labelled

Claude, Codex and OpenCode are all supported, and every capability is either
`true` or `false` **for a documented upstream reason**. That is the bar, and it
is deliberately not "everything works everywhere" — ACP has no steering method,
so flag-for-flag parity is unreachable and pretending otherwise would just move
the lie into the UI.

Which means the interface degrades from what a provider actually does rather
than from what it advertises. A control that cannot work is disabled and says
why. Driving each capability rather than trusting the handshake found eight
answers and one real bug: `imageInput` was declared and the attachments were
silently dropped.

Local models are first class alongside them: **LM Studio, Ollama and llama.cpp**,
no account and no network.

### Tools run confined, or they do not run

Commands execute inside an OS sandbox — Seatbelt on macOS, bubblewrap on Linux
— across two axes copied from Codex: what the OS permits, and when a human is
asked. Where nothing can confine a command, Artemis **refuses rather than
silently downgrading**.

The check that proves this works caught the sandbox failing: a blanket
`/private/var/folders` rule made every other application's scratch directory
writable, and a command escaped the workspace. The profile now allows exactly
the roots it was handed and nothing else.

### It looks like itself now

The old palette was six steps of elevation, Vercel's typeface and the violet
every tool of this generation uses — each decision defensible alone, and
together somebody else's identity.

Now: one plane and a hairline. Depth is deleted rather than reduced, so
boundaries are rules instead of stacked greys. Archivo and JetBrains Mono.
A teal accent. Radius carries meaning — square for what the machine produced,
soft for what you operate. A new mark: a square frame around a half-lit moon,
which is that same rule drawn at 512.

**Waiting looks different from working.** A run is starting, running, waiting on
you, failed or settled — five named states where several used to be the same
grey dot — and each says *why*. A queued permission outranks a running status,
because a provider that has asked for something is, to you, waiting. Elapsed
time sits beside it, because "is it stuck" is the real question and a spinner
cannot answer it.

### The conversation reads as a conversation

The transcript used to interleave everything as it happened: a paragraph, a
`Ran 3 commands` bar, the rest of the paragraph. Now the calls sink to one
marker at the foot of the exchange — growing as the run works, folding open in
order — and the boundary is the *break*, when the model stops and waits.
Interrupting a run to redirect it does not split the account in two; steering
one request is still one request.

Reasoning is a message, not machinery. It stands where the model wrote it, as
muted prose beside a sage rule, on by default — the Appearance switch now only
decides whether a block arrives expanded. And the provider avatar is gone from
the gutter: which model wrote a turn is a fact that does not change per row,
and the status line already says it once.

While a run is live, the border above the composer is the indicator: an
ordinary hairline at rest, it grows to carry the shuttle while work happens,
amber while something waits on your answer, signal when a run fails. The words
— which state, why, for how long — stay at the foot of the conversation.

### The dock grows a file browser, and files stop evicting each other

The working directory sits in the dock: the column's own folder, icons by
kind, `..` at the top of every listing, click a file to read it. The reader is
the same one the transcript's links open — same channel, same gates, syntax
highlighting included — and every file now gets a tab of its own. Following a
second link used to replace the first, which made the thing reading code is
mostly made of impossible. Tabs keep their own scroll positions, a path opened
twice is one tab brought forward, and a restart reopens what was open.

The strip that holds it all runs down the dock's side instead of across its
top, so tabs cost height in a column that scrolls rather than width the
composer needed.

### The command bar searches what it says it searches

Typing a session's title into ⌘K used to return "Nothing matches that" — the
sessions were a page down, behind a row named "Resume a past session…".
Matching sessions now join the results as you type, found by title, opening
prompt, branch, project or profile. An empty bar still shows commands, so it
opens as a menu and behaves as a search.

### What the tests now enforce

Four checks that read the source and fail the build, added because prose does
not fail a build:

- every palette value falls inside sRGB, clears WCAG AA on both grounds, and
  keeps 40° of hue separation
- nothing in the normal flow lifts off the plane
- small caps are spelled one way
- every colour class names a token that exists

Writing them found bugs that judgement had not, including one that shipped in
two previous releases: `--line-strong` had never met WCAG 1.4.11 in dark mode.
It draws scrollbar thumbs and radio borders, which are owed 3:1, and it measured
1.97.

### A beta channel, off by default

Settings → Advanced has a switch that widens what the updater will offer this
installation to include prereleases. It is off unless you turn it on, and it
changes nothing else: a beta is the same build as the release that follows it,
tagged earlier, and the version you are offered still lands on the stable one.
Turning it back off uninstalls nothing.

Building it fixed a bug that had been there the whole time — the update
comparator returned false for any version carrying a suffix, so a beta build
could never have updated itself, not even to the release it was a rehearsal for.

### The work gets handed on before the account runs out

Running out of plan mid-conversation loses the expensive part — not the turn,
but everything the agent had worked out: which files matter, what it had already
tried, what it was about to do next. On, Artemis stops just short of the limit
and spends the last of the budget asking for a briefing the next session can
start from, written into `.artemis/` and shown as an artifact.

It stops at **90% of the 5-hour window, 98% of the weekly, 95% of Fable** —
different margins because the 5-hour window refills within the day and the
weekly one does not. It interrupts a run in flight to do this, so it is **off
unless you turn it on**, in Appearance → Handing over, and every conversation it
stops offers a button to carry on regardless.

Plan usage is now read every two minutes rather than every five, and between
those sweeps only the accounts with a run on them are read — so an idle machine
polls no harder than it used to.

### Escape asks first

Escape closes the palette, closes a dialog, denies a permission the agent is
waiting on, and stops the run. Only the last of those is destructive, and it
shares a key with three reflexes that are not: reaching for Escape to dismiss
something that has already gone stopped the work instead. There is a switch in
Appearance → Keyboard now. Off, Escape still does the other three; the Stop
button is untouched.

### A message no longer disappears into a run that just ended

Sending a prompt as a turn finished could produce *"Run … has already ended"* —
a red banner over a dimmed message, with nothing to do but type it again. The
window and the main process simply disagreed for a few milliseconds about
whether the run was still live. The prompt now starts a fresh turn instead,
which is what it would have done had the two agreed.

### Also

- `pnpm package` works from a clean checkout. It used to depend on `typecheck`
  having run first to build the workspace libraries, which was true in CI by
  accident of ordering and false on a new machine.
- The slowest test in the suite was not flaky, it was queueing on a real 600ms
  debounce five times over. 2.91s to 542ms.
- Private vulnerability reporting is enabled, so `SECURITY.md`'s link resolves.

### Known

- The light theme's accent is muted and cannot be otherwise: teal is the
  narrowest useful hue in sRGB at mid lightness. Documented rather than nudged.
- The tasks and agent panes have the new surface treatment but not a rethought
  one. Delegation is still presented as a list.
- Unsigned, as before. Every artifact is built on the machine it targets and
  boots before it ships.

## What's new in 0.20.0

- **Watch the model think, if that is what you came for.** Thinking folds into
  the activity marker with the calls it was reasoning about, which is right when
  reasoning is context for the answer and wrong when it is the thing you have
  the app open to see — it put the interesting part behind two clicks. There is
  a switch in Appearance now, off by default. On, a burst becomes reasoning in
  the thread with markers between the paragraphs for the work, and the blocks
  render open as muted prose, growing as the model writes them. It applies to
  the conversation already on screen, so you can flip it and look rather than
  flip it and wonder. A single block you would rather not read still collapses
  on its own, and stays that way.

- **A conversation no longer stops dead while you look at something else.** With
  Artemis behind another window — minimised, covered, on another Space — the
  transcript could freeze while the agent carried on working, and then deliver
  everything in one burst when you came back, reloaded, or stopped and started
  the session. The moment you most needed to follow was the moment all of it
  arrived at once.

  Two separate causes, both now fixed. The transcript batched its updates onto
  an animation frame, and a window that is not being drawn is never given one —
  so the batch was never applied and every later update queued behind it. And
  re-attaching after a reload held each conversation's live events while it read
  that conversation's history back, one after another, with no time limit: the
  more sessions you had running, the longer the last of them stayed silent.
  Anyone working across several accounts saw this most, because switching
  between them is what triggers the heavy history reads.

## What's new in 0.19.0

- **A conversation that is still working keeps its column.** Leaving one —
  clicking another session, closing a pane — could throw it away outright: the
  bow went to rest, the workflow tab shut, and the button that reopens it sat
  disabled with nothing to show. The agent never stopped; sending it any
  message brought the whole thing back. The cause was that a window decided
  "finished" from its own delegated rows, and those rows stop arriving the
  moment the launching turn ends — which is exactly when a workflow starts
  outliving it. The main process always knew, and can now be asked, so the
  sidebar keeps marking work that has outlived its turn and a column is set
  aside rather than destroyed. Anyone running several accounts at once hit this
  hardest, because switching between them is all navigation.

- **A window in the background keeps its clocks running.** Timers were being
  throttled to roughly once a minute whenever Artemis was not the front window,
  which stalled the delegated-agent view and the history feed for precisely as
  long as you were looking at something else. Coming back showed a frozen
  indicator over an agent that had been working the whole time.

## What's new in 0.18.0

- **Cerebro waits to be asked.** Having the bank cloned on this machine was
  being read as consent to it: every run start synced it — promoting drafts and
  opening pull requests against a repository the whole team shares — and its
  prompt spent context on every run of every profile. There is a switch now, at
  the top of Settings → Cerebro, and it is **off**. Turning it on wires every
  profile back up and syncs once; turning it off unwires them, so the
  instruction block, the `/cerebro` command and the session-start hook come out
  rather than staying live for a stock Claude Code on the same machine. The
  built-in Cerebro prompt follows the switch instead of carrying one of its own
  — your preference on that row is kept, it simply is not sent while the bank
  is off.

  **If you already had Cerebro working, it goes quiet until you throw the
  switch.** That is the point of the default, not a migration gap.

## What's new in 0.17.1

- **The Delegated pane opens when you ask for it.** Turning off *Open on its
  own* was taking the header's Delegated button with it: with agents working,
  the button lit up and pressing it did nothing at all — and since a subagent's
  transcript is reachable only from those rows, nothing delegated could be
  watched at all while the setting was off. The rows were never lost, only
  undrawable. The delegated tab is the one surface in the dock with two
  origins — it arrives with the work, and it opens on a press — and the strip
  now tells the two apart. Delegated work still opens nothing by itself; a
  press opens it, and its ✕ hands the setting back.

## What's new in 0.17.0

- **The team memory bank starts pulling its weight.** Cerebro's sync now runs
  from Artemis itself at every run start — the SessionStart hook it used to
  rely on lives in settings files Artemis deliberately never loads, so for its
  first three days the bank never synced and no agent ever wrote to it.
  Drafts promote, teammates' memories arrive, and new projects get the bank,
  all without a hook.

- **Agents are actually briefed on the bank.** The built-in Cerebro prompt was
  four bullets naming a command that wasn't on anyone's PATH. It now carries
  what the managed CLAUDE.md block was never able to deliver: maintaining the
  bank is the agent's job, the command resolves (with a fallback path), team
  facts route to the bank rather than personal memory, and repo-specific
  facts are scoped with `--applies-to` so one repo's conventions stop
  spending every other repo's context. Three prose assertions in the test
  suite keep those sentences from silently vanishing.

- **Memories enter through agents, and only agents.** The Cerebro pane's
  draft form is gone, along with its whole IPC channel: a human-facing form
  was a second authoring path that knew none of the house style agents are
  prompted to apply. State the fact to an agent instead — cheaper, and it
  lands scoped and styled. The pane keeps what a window should have: setup,
  sync, the memory list, and retire.

## What's new in 0.16.2

- **The hunt has a quarry, and it rides with the text.** The bow scene moves
  inside the conversation itself — at the bottom of the text, pushed down by
  each line as it streams in, scrolling with the transcript, spanning exactly
  the width of the prose. And the bow finally shoots at something: a stingray
  idles at the far side, swimming in place while the run works, flinching in
  the exact frames the arrow lands, frozen mid-swim while a permission waits
  on you, and dimming with the bow when the run ends — plainly never struck,
  because the hunt is the run and the run always comes back for another pass.

## What's new in 0.16.1

- **The bow answers its first day of feedback.** The hairline sweep above the
  input is back — trading it away in 0.16.0 was a misread — and the bow moves
  to its own strip directly under the transcript, where it now stands
  *constant*: at rest before the first run and after the last answer, firing
  in between, holding at full draw while a run waits on you. And it draws in
  moonlight rather than machine-cyan — `lunar` is the accent named for
  Artemis' own light, and it is the colour the runbar already sweeps in, so
  the two indicators finally read as one system.

- **The side pane can be told to wait.** A new Appearance option, on by
  default: the dock opens itself when the agent produces something to look at
  — the first artifact of a conversation, delegated work, a page the agent is
  browsing. Turn it off and none of that appears without a click. An artifact
  waits behind its tile's Open button, anything that arrived unseen is
  revealed by turning the option back on, and nothing you opened yourself —
  shells, pages, previews — is ever touched.

## What's new in 0.16.0

- **Artemis draws her bow.** The hairline that swept the seam between the
  transcript and the composer is now a bow — the app's namesake, on screen at
  last. It fires for as long as a run is going: draw, hold, loose, a cyan arrow
  flying the width of the pane. A run parked on a permission holds at full draw
  — aimed, dead still, waiting on you — and a finished run rests it: string
  straight, arrow gone, dimmed to faint. The animation stopping rather than
  vanishing is the point; a resting bow under an answer is what a completed run
  looks like now. A pane that has never run shows nothing at all,
  `prefers-reduced-motion` gets a still nocked bow instead of the loop, and
  none of it goes near the per-token path — three poses driven by the run's own
  status, four CSS animations sharing one 2.4-second clock.

## What's new in 0.15.1

The rest of 0.15.0's account work. That release stopped new sessions piling onto
one account; this one closes the gap right after a run ends, and makes the two
places you would go to check any of it tell the truth.

- **A finished run re-reads the account it just spent.** While a run is live,
  0.15.0's reservation covers it — the ranking knows work is committed to that
  account even though the polled reading does not show it yet. The moment it ends
  that cover is withdrawn, correctly, and the account falls back to a reading
  taken *before any of the work happened*. So it read emptiest at exactly the
  moment it had just been drained, and won the next session. One targeted read,
  four seconds after the end, closes it — collapsed to one read per account when
  a burst of work settles at once.

- **The usage rings follow the poll.** They rendered a copy of the reading loaded
  when the meter mounted, and never saw the readings the background poll had been
  collecting since. Sit on one account through a long job and the 5-hour ring
  would not move, though the true figure was already in memory. Reloading the
  window fixed it — which is what "sometimes I have to refresh" turned out to
  mean. They now take whichever reading is newer, so the manual refresh button
  under them still wins when it is.

- **Account rows show their plan again.** The tier was hidden unless a sign-in
  probe had confirmed the account, and nothing ran that probe until you opened
  Settings → Profiles — so on a fresh launch every row in the picker came up
  unlabelled, despite the plan poll already knowing. The tier now hides only for
  an account actually checked and found signed out, and the account you are about
  to run on gets its sign-in state read at the three moments it can change.

## What's new in 0.15.0

A release about running several accounts at once. Every item below was reported
by someone working across eight profiles, and all four turned out to be the same
thing seen from different sides: the app knew which accounts existed and not
which ones were *in use*.

- **A new session stops piling onto the account the last one is draining.** The
  chooser ranked accounts on a polled reading, and the poll lags its own
  consequences — start a session, it takes the emptiest account and begins
  draining it; start another a minute later and nothing has re-polled, so the
  same account still reads emptiest and wins again. Four or five sessions landed
  on one profile while the rest sat idle. It got *worse* the more accounts you
  had, because the poll walks them one at a time and a longer cycle is a longer
  blind window. The ranking now subtracts what the runs already on an account
  are committed to spending, weighted by model and effort — a Fable ultracode
  session counts several times what an Opus max one does, because ultracode
  multiplies how many turns there are rather than how long one takes.

- **A session resumes on the account it last ran on.** With `projects/` shared
  across profiles, clicking a row labelled "Claude 5x" while working on "Claude
  3x" left the status line saying 3x, billed 3x, and then quietly relabelled the
  row 3x on the next listing — a conversation that appeared to wander between
  accounts on its own. The row, the status line and the account billed now
  agree. The odds of hitting this fell to nothing with two accounts and to
  almost certain with ten, which is why it went unnoticed for so long.

- **Every account in the picker shows how full it is.** The menu answered "which
  accounts do I have" and the rings answered "how full is the one I'm in".
  Neither answered the question that arrives with a fistful of accounts. Each row
  now carries the window that will actually stop that account first — the
  tightest one, not an average — in the same colours the rings use, read straight
  off the poll so opening the menu starts no work.

- **A GitHub PR link says where it stands.** Hover one in a transcript for its
  state, whether checks are green, and the size of the diff. The reading comes
  from your own `gh`; Artemis stores no GitHub token and has nowhere to put one,
  so with no CLI or no login the link stays exactly the link it was.

## What's new in 0.14.2

- **Delegated work splits live from finished.** The pane answers one question —
  is it still going — and a flat list answered it worst exactly when it mattered
  most: a workflow that had settled thirty agents pushed the two still running
  off the bottom. Running work is now on top and always visible; finished work
  is under a heading that says how much of it there is and starts shut. Closing
  it sticks, so a task settling does not make the pane jump.

- **Each item is a card.** The pane holds a one-line `Bash` next to a workflow
  with four phases and twenty agents folded underneath, and run flat the phase
  tree of one item read as though it belonged to the next. Settled cards are
  recessed rather than raised.

## What's new in 0.14.1

- **The browser has a button, next to the terminal's.** 0.14.0 hid it behind a
  menu on the dock's `+`, which was worse than the button it replaced: `+` on a
  tab strip already means "another of these", and putting two one-line choices
  behind a click cost everyone a step to reach what used to be direct. `+` opens
  a terminal again, and the browser sits in the header beside the terminal —
  which is where you look for "open a thing" — on **⌘⇧B**.

  One limit worth knowing: the shortcut cannot fire while the *page itself* has
  focus, because the page is a separate renderer and the app never sees the
  keystroke. It works from the address bar and anywhere in the app's own chrome.

## What's new in 0.14.0

- **A browser in the dock, and the agent can drive it.** The rail held a file
  and a shell; it now holds a page. Open one from the `+` menu, type an address,
  and it renders beside the conversation — a dev server on `localhost:5173`, a
  vendor's documentation, a staging environment you have signed into, since the
  session persists across restarts. The agent gets tools for the *same* page, so
  when it navigates or fills a form you watch it happen rather than reading
  about it afterwards; a browser it opens appears as a tab without stealing the
  one you were looking at. Every tool call goes through the ordinary permission
  prompt, because an MCP tool is a tool.

  A page runs with **no preload script**, on its own session, as a sibling of
  the app rather than a frame inside it — so there is no `window.artemis` to
  find and nothing for it to call. Only `http` and `https` load: `javascript:`
  is code, `data:` is a page with no origin, and `file:` is your disk. There is
  no search box, deliberately — an address bar in a coding tool sees internal
  hostnames and the occasional mis-pasted token, and a typo should not become a
  request to somebody else's server.

- **A path is a link only where there is a file.** Last release made every path
  in an answer clickable, and it was too eager: the rule for spotting one only
  ever had a string to look at, so `e.g` became a link and so did the file an
  agent had merely *said* it would write. Clicking either opened a pane saying
  there was nothing there. Artemis now asks first, in one batched question per
  answer, and a fragment stays plain text until the answer comes back. A *yes*
  is remembered; a *no* is re-asked when the next answer arrives, so the file
  the agent promised in one turn is a link by the next — and a window nobody is
  typing into does no work at all.

- **A file full of secrets opens.** Reading a `.env`, a README documenting an
  `sk-ant-…`, or a checked-in PEM fixture failed outright with a
  credential-safety error: the channel that reads a file as text was never given
  the policy its sibling has, so Artemis refused to show you a file already on
  your disk. Both now share one policy, named for what it is.

## Install

**macOS** — download `Artemis-<version>-arm64-mac.dmg` (Apple Silicon) or
`Artemis-<version>-x64-mac.dmg` (Intel), open it, drag Artemis into
Applications. If macOS blocks the first launch, allow it under System
Settings → Privacy & Security → "Open Anyway", or clear the quarantine flag:

```
xattr -dr com.apple.quarantine /Applications/Artemis.app
```

**Windows** — download and run `Artemis-<version>-x64-setup.exe`. SmartScreen
will warn about an unrecognized publisher; "More info" → "Run anyway".

**Arch Linux (x86_64)** — download `Artemis-<version>-x64.pacman`, then install
it from the directory where you saved it:

```bash
sudo pacman -U ./Artemis-<version>-x64.pacman
```

## First run

1. You need Anthropic's `claude` CLI installed, and a Claude subscription.
2. In Artemis, open **Profiles** (⌘, / Ctrl+,) and create a profile.
3. Run the sign-in command Artemis shows you in your own terminal and finish
   in the browser — Artemis watches the profile directory and continues on its
   own. No credential ever passes through Artemis.
4. Set a working directory, send a prompt.

Runs are billed to the Claude account each profile is signed into.

## Updates

Artemis checks this repository for newer releases — public, so no account or
GitHub CLI is needed — and puts a card at the foot of the sidebar when one
exists, or a strip under the header if the sidebar is hidden. Installing
parks at "restart when you're ready" — nothing restarts on its own.

Feedback: **Report a bug** at the foot of the sidebar, or open an issue in
this repo.
