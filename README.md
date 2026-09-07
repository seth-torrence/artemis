# Artemis

A desktop UI for agentic coding CLIs.

Artemis is an open-source Electron app that puts a real interface in front of
command-line coding agents: a readable transcript, an approval surface you can
actually reason about, isolated accounts you can switch between, and session
history you can browse. Claude, Codex and OpenCode are the providers today —
and through OpenCode's own configuration, any model it can be pointed at,
including ones running locally.

Powered by Claude.

---

## Status

Working end to end for all three providers. You can create a profile, sign it
in with the provider's own CLI, start a run, watch it stream, approve or deny
tool calls, interrupt it, and browse past sessions.

Codex and OpenCode show as available whenever their CLI is on your `PATH`;
when it is not, the profile screen greys the provider out and says so rather
than hiding it. Every provider id the protocol declares now has an adapter
behind it.

What each one can do differs, and the UI reads that from the provider rather
than assuming: OpenCode has no mid-run steering (its protocol models a turn as
one request) and offers two permission modes rather than six, so the composer
locks while it works and the mode picker is shorter. Nothing is hidden — the
affordances it lacks are disabled with a reason.

## Authentication

**Artemis never performs a login, and stores no credential of any kind.** It
has no OAuth flow, opens no browser to sign you in, refreshes no tokens — and
it holds nothing you could paste into it. There is no key field anywhere in the
app.

A profile is a label and a config directory. To sign one in, Artemis composes
the provider CLI's own login command with the profile's directory set inline:

```bash
CLAUDE_CONFIG_DIR='…/Artemis/profiles/work' claude auth login
```

You run that line in your own terminal. The CLI opens the browser, completes
the login, and writes its credential into that directory; Artemis polls the
CLI's status probe (`claude auth status`) and moves on by itself when the
directory answers "signed in". The credential belongs to the provider's CLI,
lives where that CLI keeps it, and never passes through Artemis in either
direction.

### The one place Artemis runs the login for you, and what that does not change

The paragraph above describes a machine with a person sitting at it. A headless
Artemis in a container has no terminal to hand that line to — `docker exec`
reaches an arbitrary replica under an orchestrator, and the web terminals that
do exist cannot paste over plain HTTP — so the account that makes a server
useful was the one thing the deployment could not install.

There, a connection token granted account administration may drive the login
over HTTP from a desktop Artemis. The server spawns the provider's own CLI;
with no browser to open, that CLI prints a verification URL and waits for a code
on stdin. The desktop app shows you the URL, you sign in in your own browser,
and you paste the code back. Two strings cross the wire.

Every sentence at the top of this section still holds, and none of them is
weakened by the word "spawns":

- **No OAuth flow is Artemis's.** The exchange is the provider CLI's, exactly as
  it is when you run the command yourself.
- **No credential is read, parsed, forwarded or stored.** The CLI writes its own
  token into its own config directory, on the serving machine. Nothing in
  Artemis reads that file; whether the login worked is answered by asking the
  CLI's own status probe.
- **The code is never logged and never appears in an error.** It goes to one
  subprocess's stdin and nowhere else.
- **It is off unless an operator turned it on**, per connection
  (`connection create --manage-profiles`), because adding an account to a server
  is an administrative act and not something a token pasted into an editor
  extension should be able to do.

### Why the account is a property of the directory

The Claude CLI keys both its credential and its session history on
`$CLAUDE_CONFIG_DIR` (Codex does the same with `CODEX_HOME`), so one profile,
one directory, one account, one history. Two profiles pointed at the same
directory are the same account, which is occasionally what someone means.

An earlier design stored the credential itself, alongside an auth mode saying
which environment variable to emit it as. That design had a defect it could not
be rid of: `ANTHROPIC_API_KEY` silently outranks a subscription login, so a
profile that said "bill my plan" could bill metered API usage instead. Artemis
now emits no credential variable at all and strips every one of them —
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and the rest of the provider's
credential surface — from the environment a run inherits. The only thing that
can authenticate a run is the login inside the profile's own directory, which
makes the billing trap structural rather than policed.

### If you are distributing Artemis

Anthropic's Agent SDK documentation states that third-party developers may not
offer claude.ai login or subscription rate limits for their products without
prior approval from Anthropic. Artemis's sign-in flow ends in exactly that
login, so if you are shipping a build of Artemis to other people, seek that
approval first. Running your own build against your own subscription is a
separate matter from distributing one.

## Getting started

Requires Node 22+ and pnpm 10+.

```bash
pnpm install     # Electron downloads its runtime on first use
pnpm dev         # build the shared packages, then launch the app
```

Other tasks:

```bash
pnpm typecheck   # build the project graph and typecheck every package
pnpm test        # vitest across the workspace
pnpm build       # production bundles into apps/desktop/out
pnpm smoke       # headless end-to-end run, no Electron (see below)
```

### From the terminal

The same engine, the same profiles, no window: `apps/tui` is a terminal UI in
the shape of the provider CLIs themselves, with the accounts you have signed
in through the desktop app available to switch between.

To install it on a machine that has the desktop app:

```bash
curl -fsSL https://raw.githubusercontent.com/seth-torrence/artemis/main/install.sh | bash
```

That downloads the self-contained build for your platform from the latest
release into `~/.local/share/artemis-tui`, fetches a Node 22 runtime beside it
if the machine has none new enough, and writes `artemis-tui` into
`~/.local/bin`. Every release ships builds for macOS on Apple silicon and
Linux on x64; `ARTEMIS_TUI_VERSION=2.5.0` pins one. `artemis-tui --update` moves to the
latest release, and an installed copy checks once a day whether there is one,
saying so in the status line and downloading nothing until asked. Removing
those two paths is the uninstall. On Windows, or to run the current source:

```bash
pnpm build:libs                     # the shared packages it is built on
pnpm tui                            # build and open a conversation in this directory
ln -s "$PWD/apps/tui/dist/main.js" ~/.local/bin/artemis-tui   # then from anywhere
```

The bin is published under two names, `artemis` and `artemis-tui`. On a
machine with the desktop app installed, `/usr/bin/artemis` is the desktop's
own launcher and wins the name; use `artemis-tui` there.

It takes the whole terminal, in your terminal's own colours: a header with the
mark and the working directory; a rail on the left listing every conversation
across all your accounts, grouped by project with worktrees folded into their
repository as the desktop does (Tab focuses it, Enter opens one, switching
account and working directory to wherever it ran); the conversation, anchored to the bottom and
scrolled with the arrow keys or the mouse wheel, Shift+arrow by the half-screen, Esc back to the end; a composer; and under it the line that says what
the next message goes out as — account, model, permission mode, plan usage —
with a status line beneath.

Inside it, `/profile`, `/model` and `/mode` open pickers for the account, the
model (with its effort and speed where the model has them) and the permission
mode, and whichever you last chose is what the next launch opens as. `/resume`
lists this directory's stored conversations and picks one up (`artemis -c`
opens the newest straight away); `/cwd`, and the rail's "in another folder…",
choose where to work — a folder you have used before, or one found by
browsing; `/attach <path>` sends an image or file with the next message; `/tasks` shows background work and, for a delegated agent, what it
did; `/usage` shows the plan's windows. `/new` starts over, `/help` lists the
rest. Typing `/` also offers your own skills and the provider's commands, by
the name you would think of: `/code-review` finds
`artemis-skills:code-review`. In the rail, `a` archives a conversation and `d`
deletes one; archiving writes the same tag the desktop reads, so a
conversation put away in either is put away in both. Esc interrupts a turn; Ctrl+C twice quits. Permission prompts appear inline and open on *Deny*, so a
stray Enter never authorises anything. For scripts,
`artemis --print "<message>"` runs one turn, writes the answer to stdout and
denies any prompt it would have had to ask you about.

With no `--profile`, it opens as the account that last worked in that
directory. Your skills, slash commands and marketplace plugins reach every
turn through the same content bridge the desktop uses, so the model sees what
it sees there.

It reads the desktop app's data directory — `~/.config/Artemis` on Linux,
`~/Library/Application Support/Artemis` on macOS, `%APPDATA%\Artemis` on
Windows — so an account signed in there works here the same minute. It never
writes to that directory. `ARTEMIS_DATA_DIR` points it elsewhere.

What it does keep is one small cache of its own: the last plan reading, model
list and account catalogue, each of which costs a subprocess to read. The
next launch opens on those and refreshes them behind the screen, so the line
under the composer is filled from the first frame and `/model` and `/profile`
open at once. It lives under the platform's cache directory —
`~/.cache/artemis/tui`, `~/Library/Caches/Artemis/tui`,
`%LOCALAPPDATA%\Artemis\tui` — and losing it costs one slow launch.

### Adding an account

Artemis has no credentials of its own and cannot do anything until you give it
a profile that is signed in.

1. Launch the app (`pnpm dev`) and open **Profiles** — the "add one" link on the
   welcome screen, or <kbd>⌘</kbd><kbd>,</kbd>.
2. **New profile**, then give it a label (for example `Work` or `Personal`).
   Artemis suggests a config directory under its own user-data directory; you
   may replace it with any absolute path. Pointing it at the `~/.claude` you
   are already signed in to is the usual shortcut, and makes that account this
   profile's account with no login step at all.
3. Sign in. Artemis shows the provider CLI's login command with the profile's
   directory set inline; run it in your own terminal. The screen polls the
   CLI's status probe and continues on its own when the login lands.
4. Set a working directory in the top bar, type a prompt, and send.

Each profile's config directory isolates its credential *and* its history, so
two profiles never share either unless you point them at the same directory on
purpose. Artemis can recommend which account a fresh session starts on — each
profile can opt out of being chosen — but a running conversation stays on the
account it started with; nothing rotates accounts mid-run.

## Architecture

### Why a seam, not an integration

The three providers Artemis targets have nothing in common at the transport
layer:

| Provider | Transport                                        |
| -------- | ------------------------------------------------ |
| Claude   | in-process Node library                          |
| Codex    | subprocess speaking JSON-RPC over stdio          |
| OpenCode | subprocess speaking the Agent Client Protocol    |

Two of those are JSON-RPC over a pipe and still share almost nothing: Codex's
app-server is its own vocabulary, while OpenCode speaks ACP — an open protocol
several vendors have adopted. That difference is why the ACP half lives in
`adapters/acp` rather than inside the OpenCode adapter: it is the
vendor-recommended surface for Kimi Code and Grok Build too, so the next
adapter of that kind is a mapper and a credential spec rather than a second
transport.

So the abstraction cannot be shaped like any one of them. Every adapter
normalizes its native stream onto a single eleven-variant event union —

```
session.started | text.delta | text.complete | thinking.delta | tool.start
| tool.end | permission.request | permission.resolved | usage
| background.tasks | run.end
```

— and publishes a capability descriptor up front:

```ts
interface Capabilities {
  interactivePermissions: boolean
  partialMessages: boolean
  midRunSteering: boolean
  forkSession: boolean
  listSessions: boolean
  subagents: boolean
  // …plus permission modes, resume, rename/delete, usage and cost reporting
}
```

The UI reads that descriptor and *degrades*: it hides the fork affordance when
a provider cannot fork, and renders whole messages instead of a typewriter when
a provider cannot stream. Nothing assumes every provider can do everything.

Registering a provider is one line, in
`packages/core/src/adapters/registry.ts`:

```ts
export function createDefaultProviderRegistry(options?) {
  return createProviderRegistry([
    createClaudeAdapter(options?.claude),
    createCodexAdapter(options?.codex),
    createOpencodeAdapter(options?.opencode),
  ])
}
```

That claim has been tested twice now: adding Codex, and then OpenCode, was
this array plus an options field, with nothing changed elsewhere in the app.
The second time cost two test edits as well — both in the registry's own
suite, which had been using OpenCode as its example of a provider with no
adapter behind it.

An adapter declares its own credential vocabulary alongside its capabilities —
which variable points the provider at the profile's isolated config directory
(`CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex, `XDG_DATA_HOME` for
OpenCode), which credential variables could authenticate the provider some
other way and must therefore be stripped, and the sign-in commands (login,
status probe, logout) with a sentence of prose to show beside them.
`resolveEnv` reads that spec rather than any provider's variable names, and the
profile screen composes its sign-in instructions from it, so a second provider
does not need a change anywhere outside its own adapter. Nothing in
`@rx-artemis/protocol` names a variable or a command; it defines the shape and
the adapter supplies the contents.

OpenCode is the case that shows why the variable is the adapter's to choose
rather than a convention to guess at. It ships an `OPENCODE_CONFIG_DIR`, and
that is the *wrong* variable: it relocates configuration while the credential
stays in `~/.local/share/opencode/auth.json`, so two profiles set up that way
would quietly share one account. `XDG_DATA_HOME` is what actually moves the
account. The scrub list is longer than any other provider's for a related
reason — OpenCode will authenticate to any of twenty model providers from the
environment, and every one of those outranks the profile's own login.

### Local models

Local models are their own provider, not a way of configuring another one.

The route through OpenCode looks obvious and was tried first: point its config
at an OpenAI-compatible endpoint and the models appear. It gets as far as
*listing* them. A real turn against a local model hung for five minutes and
emitted nothing, while a direct request to the same endpoint answered in 1.16
seconds — so inference was healthy and the agent path was not. Reusing
OpenCode's own provider id made it worse: its catalogue merged in three models
that were not downloaded on the machine, so the picker offered work that would
fail on selection.

So the seam gains a fourth adapter instead. The honest cost is that a bare
endpoint is not an agent runtime — Claude, Codex and OpenCode each ship
something that owns the tool loop, and an inference server does not. **For local
models the loop is Artemis's**: the tool schemas, the execution, the permission
gate and the result-feedback cycle. The transport is the easy half.

That is a real expense and it buys something the other three cannot offer: every
`false` in this provider's capability descriptor is a *not yet* rather than a
*cannot*, because nothing upstream is imposing the limit.

See [docs/research/LMSTUDIO-ADAPTER-RESEARCH.md](docs/research/LMSTUDIO-ADAPTER-RESEARCH.md).

### The path a prompt takes

```
  renderer          submitPrompt() mints a runId, paints optimistic UI
     │              and starts matching events before start() resolves
     ▼
  window.artemis      preload/index.ts — the whole attack surface.
     │              67 fixed channels, no ipcRenderer passthrough,
     ▼              no channel name ever built from renderer input
  ipcMain           main/ipc.ts — verify sender, validate and rebuild the
     │              payload, dispatch, then scan the response for secrets
     ▼
  ArtemisEngine       main/engine.ts — the composition root
     │
     ▼
  RunRegistry       core/sessions — mints or accepts the run id, resolves
     │              the run's environment via resolveRun, fans out events
     ▼
  resolveEnv        core/profiles — build the env bundle from the provider's
     │              credential spec: point its config-dir variable at the
     │              profile's directory, delete every credential variable
     ▼
  ClaudeAdapter     core/adapters — merges the host env (scrubbing every
     │              inherited credential), calls the Agent SDK
     ▼
  Agent SDK
```

Agent events come back the other way on one push channel, and the renderer
demultiplexes on `event.runId`. A channel per run would force the preload to
build channel names out of renderer-supplied strings, which is exactly the
pattern it is not allowed to have.

### Where secrets live

Nowhere in Artemis, and that is the design rather than an oversight. The
provider's own CLI login writes its token into the profile's config directory;
Artemis's part is to set one environment variable pointing the provider there
and to read a boolean back. `profiles.json` — the whole of what Artemis
persists about an account — is labels and directory paths, readable plaintext
by design, with nothing in it worth stealing.

**No secret crosses the IPC boundary into the renderer, because none exists to
cross.** The renderer sees `ProfileMetadata` — id, label, provider, the
config-directory path, an optional colour and plan pin — and nothing else.
There is no channel in either direction that carries a credential: the `auth`
namespace is a status read and a sign-out, and the profile editor submits a
label and a path.

Three things enforce that rather than merely documenting it:

- No credential channel exists to misuse. Of the 67 fixed channels the preload
  exposes, none accepts or returns a token, `ipcRenderer` is never exposed or
  wrapped, and no channel name is ever built from renderer input — so the
  reachable surface is fixed at build time and readable in one screen.
- Every `invoke` response is scanned on its way out (`main/redact.ts`): key
  names that mean the wrong shape was returned (`publicEnv`, `secretRef`,
  `apiKey`) and credential-shaped string values (`sk-ant-…`, AWS key ids, PEM
  headers, bearer tokens) throw in the main process instead of shipping to the
  renderer. The agent-event, terminal and plan-usage pushes are scanned the
  same way before broadcast; the window-state, updater and menu pushes are
  not, and carry nothing but booleans and version strings.
- Core has no secret to leak. The profile store persists no credential and no
  handle to one, and `resolveEnv` writes exactly one variable — the provider's
  config-directory variable — while deleting every variable that could
  authenticate the provider some other way.

Model output is deliberately exempt from the value patterns: if a user pastes
their own key into a prompt, the transcript legitimately contains it, and
refusing to render the conversation would help nobody.

### Layout

```
packages/protocol/     shared types only — zero runtime deps, imported by everything
packages/transcript/   the AgentEvent → transcript-rows model, tool/diff/format helpers;
                       framework-free and Node-free, drawn by both the renderer and the TUI
packages/core/         headless engine; never imports electron
  src/adapters/        the provider seam: types.ts, registry.ts, one file per provider
    acp/               the Agent Client Protocol, shared by every ACP provider
    opencode/          ACP → event-union mapping for OpenCode
  src/profiles/        profile storage and env resolution
  src/sessions/        live-run registry
  src/workspace/       working-directory checks and naming
apps/desktop/
  main/                Electron main process — hosts core, owns the IPC boundary
  preload/             contextBridge; the renderer's entire view of the outside
  renderer/            React + Vite + Tailwind
apps/server/           headless HTTP server over the same engine
apps/tui/              the terminal UI (Ink) over the same engine; bin `artemis`
scripts/smoke.ts           headless end-to-end run against Claude, no Electron
scripts/opencode-smoke.ts  the same for OpenCode, and it checks the event
                           stream's shape rather than trusting it
scripts/acp-probe.ts       drive any ACP agent's handshake — how a candidate
                           provider is verified before an adapter exists
```

Three boundaries are enforced by the type system rather than by convention:

- `@rx-artemis/protocol` compiles with `"types": []` — no ambient Node, so it cannot
  reach for a filesystem.
- `@rx-artemis/core` has no dependency on `electron` and must never gain one; it
  runs under plain Node and under vitest with no Electron present. A test
  (`packages/core/src/no-electron.test.ts`) fails the build if that changes.
- `apps/desktop/renderer` compiles without `@types/node`, so `fs`, `process`
  and `electron` are not merely discouraged there — they do not typecheck.

## Debugging without Electron

`scripts/smoke.ts` runs the whole engine — profile store, environment
resolution, run registry, Claude adapter, Agent SDK — in a plain Node process,
and prints the normalized event stream:

```bash
pnpm smoke
pnpm smoke "list the files in this directory"   # custom prompt
```

OpenCode has two of its own, and they answer different questions:

```bash
pnpm opencode:smoke          # the adapter: a real turn, checked for shape
pnpm acp:probe opencode      # the transport: handshake, capabilities, sign-in
```

`opencode:smoke` runs a turn through the adapter and then asserts the contract
rather than printing and hoping — session first, `run.end` last and exactly
once, `seq` dense from zero, every `tool.start` closed — before reading the
model catalogue, the session list and a resumed conversation back. It runs in a
throwaway profile directory, so it also exercises the isolation a real profile
depends on: if `XDG_DATA_HOME` ever stopped relocating the account, the smoke
would start reading yours.

`acp:probe` takes any ACP agent, not just OpenCode. It is how a candidate
provider gets verified before an adapter for it exists — the eight-requirement
audit in `docs/research/` was run through it.

No environment variable authenticates it. The script runs against the config
directory your CLI is already signed in to — `$CLAUDE_CONFIG_DIR` if set,
`~/.claude` otherwise — exactly as a profile would, **and the run is billed to
that account**. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are
deliberately ignored: Artemis strips both from every run, so a smoke test that
authenticated with one would be exercising a path the product does not have.
If the directory is not signed in, the script exits with the sign-in command
instead of starting a run.

Everything it writes — a disposable profile record and the working directory
the agent is pointed at — lives in one `mkdtemp` directory that is deleted on
exit. The config directory it reads is never written to, and your real Artemis
profiles are never touched. If the smoke test works and the app does not, the
fault is in the Electron plumbing. If the smoke test fails, the fault is in
core and you can attach a debugger to it.

## Naming

The product is **Artemis**. It is an independent open-source project: not
affiliated with, endorsed by, or a distribution of any vendor's CLI, and not a
reimplementation of one's interface. "Powered by Claude" is the extent of the
attribution. Contributions must not introduce another product's branding,
visual identity, or ASCII art.

## Contributing

**Artemis is not accepting pull requests yet. Issues are open, and they are
read.** The provider seam has been tested once, with Codex; until the OpenCode
adapter lands, the interfaces a contribution would build on are still allowed to
move, and a pull request against them could be invalidated by the very change
that proves them. [CONTRIBUTING.md](CONTRIBUTING.md) gives the full reasoning,
says what is welcome now — bug reports, ideas, design disagreement — and
documents the conventions. When the third adapter lands, that file changes.

Security reports go through [private disclosure](SECURITY.md), never the issue
tracker.

## License

[Apache 2.0](LICENSE).

Apache rather than MIT for one reason that matters here: the [NOTICE](NOTICE)
file propagates. If you redistribute Artemis, the warning about shipping a build
whose sign-in ends in a claude.ai login travels with the code, instead of staying
behind in a README you rewrote. Read it before you ship a build to other people.

The Artemis name and visual identity are not licensed under it — section 6 of
the license grants no trademark rights.
