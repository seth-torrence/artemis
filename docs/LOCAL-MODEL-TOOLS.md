# Tools for a local model

A profile pointed at LM Studio, Ollama or `llama-server` runs an agent loop that
Artemis owns — see `packages/core/src/adapters/local/`. That loop always had
four tools of its own (`read_file`, `write_file`, `list_files`, `search`) plus a
shell that only an OS sandbox may run. This document is about the three things
added on top: the tool servers it can now reach, the built-in `http_fetch`, and
what the permission modes do to all of them.

---

## 1. What a local run is offered

| Tool | Risk | Performed by |
| --- | --- | --- |
| `read_file`, `list_files`, `search` | read | Artemis, path-confined |
| `write_file` | write | Artemis, path-confined |
| `http_fetch` | write | Artemis |
| `shell` | execute | the OS sandbox, or **refused** |
| `mcp__<server>__<tool>` | read or write | a tool server |

`risk` is what the permission modes act on:

* **plan** offers only `read`. A model in plan mode is never *told* about
  `write_file`, `http_fetch`, `shell`, or any server tool that did not declare
  `readOnlyHint` — withholding beats refusing, because a model that is never
  offered a tool does not spend a turn trying it.
* **default** asks before every call.
* **acceptEdits** stops asking about `write_file` and `http_fetch`. It keeps
  asking about `shell` and about **every tool server**, because that mode's
  bargain is about edits to this working directory — which you are looking at
  and git can undo — and a server acts on a repository, a vault or a live page,
  where the next click cannot.
* **bypassPermissions** stops asking. It does *not* widen the OS sandbox; those
  are separate axes on purpose.

### The shell is refused on Windows, and that has not changed

`commandSandbox.ts` has a backend per platform: Seatbelt on macOS (verified),
`bwrap` on Linux (written from documentation, marked unverified), and **nothing
on Windows** — job objects and restricted tokens need native code. So on Windows
the `shell` tool is offered, and every command it is asked to run comes back
`Refused: …`. That is deliberate: the alternative is a silent downgrade from
sandboxed to not, on the platform least able to notice.

Nothing in this document changes that, and two of the additions are deliberately
built so as not to route around it:

* A **tool server** is reached over JSON-RPC — stdio, HTTP or an in-process
  pipe. There is no command line for the sandbox to wrap, so `needsOsSandbox` is
  false. But a *stdio* server is still a process Artemis spawns from a command
  **you wrote in settings**, not one the model composed. If you want a model to
  be able to run arbitrary commands on Windows, a stdio server you point at a
  shell would do it — and that is your decision to make explicitly, not
  something the loop does on your behalf.
* **`http_fetch`** is performed by Artemis with its own limits (below). It is
  not a way to run anything.

---

## 2. Tool servers

Artemis speaks MCP as a **client** for local profiles. Four transports:

| `transport` | Reached by |
| --- | --- |
| — (built in) | an in-process pipe to a server Artemis itself built |
| `stdio` | a child process's stdin/stdout |
| `http` | streamable HTTP |
| `sse` | HTTP + server-sent events, the older spelling |

A server's tools arrive as `mcp__<name>__<tool>`, the same spelling the
transcript, permission rules and skills already use on the Claude side.

### Artemis's own servers come for free

`artemisBrowser` — the browser in the dock — is built per run by the desktop
app and handed to whichever adapter is running. It used to reach only Claude;
it now reaches local runs too, under the same names
(`mcp__artemisBrowser__browser_read`, `…__browser_navigate`, and so on), with
the same decision table: nothing when the run is using the user's own Chrome,
the open-only server when it prefers the external browser, the dock browser
otherwise. You configure nothing for this.

### Your own servers: where they are configured

**Settings → Profiles → edit a local profile → Tool servers.** A JSON array,
stored on the profile record beside its address and its key. Empty the box to
have none.

Constraints, all checked in three places (the form, the IPC boundary, the store):

* `name` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` — anything else would be
  rewritten on its way to the model, so a permission rule naming what you typed
  would never match. Names are unique, case-insensitively.
* A `stdio` entry needs `command`; an `http`/`sse` entry needs `url`. Not both.
* At most 20 entries.
* `enabled: false` keeps an entry in the file and out of your runs.
* A name Artemis already uses (`artemisBrowser`) is **not** taken over by a
  profile entry; the profile entry is skipped and the run says so.

### Secrets

`profiles.json` is not encrypted and is not going to be. So a tool-server config
holds **references**, never values:

```json
{ "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
```

`${NAME}` is expanded, at connect time, from the environment the run resolved
with — the host environment plus the profile's `publicEnv`. A name that is not
set is **left unexpanded on purpose**: `Bearer ${GITHUB_TOKEN}` reaching a
server produces a 401 that names the variable you forgot; `Bearer ` produces a
401 that names nothing.

A value that *looks* like a credential rather than a reference is refused at the
save button. That check is crude on purpose — the cost of a false positive is
writing `${MY_TOKEN}` instead of pasting a token, which is what you should be
doing anyway.

Where the value itself lives is up to you: your shell profile, a launchd or
systemd unit, `direnv`, or a key manager that exports it. Artemis has a key
manager surface (Settings → Secrets) for its memory banks; tool servers read the
process environment, so exporting from there works the same way.

> **A tool server is started with your environment.** Artemis does not strip it,
> because a GitHub server that could not see a token would be pointless. The
> `shell` tool's environment *is* stripped, because the model writes that
> command line and does not write these. Name only servers you would run
> yourself.

### Example configs

Each of these is one element of the JSON array. Where a binary is needed it is
called out — **Artemis installs nothing.**

#### GitHub

GitHub publishes a hosted MCP server, so no binary:

```json
{
  "name": "github",
  "transport": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
}
```

`GITHUB_TOKEN` is a personal access token with the scopes you want the model to
have — read-only if you want read-only, because the server enforces the token's
scopes and Artemis cannot.

Prefer to run it locally instead? The same server ships as a container. That
needs **Docker installed**:

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "docker",
  "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
}
```

#### Forgejo / Gitea

Forgejo instances that expose an MCP endpoint are reached the same way as any
HTTP server:

```json
{
  "name": "forgejo",
  "transport": "http",
  "url": "https://git.example.org/api/v1/mcp",
  "headers": { "Authorization": "token ${FORGEJO_TOKEN}" }
}
```

For an instance without one, the community `forgejo-mcp` bridge runs as a child
process. That needs **that binary on your `PATH`**:

```json
{
  "name": "forgejo",
  "transport": "stdio",
  "command": "forgejo-mcp",
  "args": ["--host", "https://git.example.org"],
  "env": { "FORGEJO_ACCESS_TOKEN": "${FORGEJO_TOKEN}" }
}
```

#### OpenBao / Vault

A Vault-compatible MCP server run as a child process. Needs **that server
binary installed**:

```json
{
  "name": "openbao",
  "transport": "stdio",
  "command": "vault-mcp-server",
  "args": ["--read-only"],
  "env": {
    "VAULT_ADDR": "https://bao.example.org",
    "VAULT_TOKEN": "${OPENBAO_TOKEN}"
  }
}
```

Two notes worth more than the config. First, `--read-only` (or the equivalent
flag on whichever server you use) is the setting that matters: a model with
write access to a secret store can do damage nothing downstream can undo.
Second, `VAULT_TOKEN` is a *reference* here — the literal would be refused, and
should be: a vault token in an unencrypted profile file defeats the vault.

If your OpenBao is behind an authenticating proxy on a tailnet, the HTTP form
works too:

```json
{
  "name": "openbao",
  "transport": "http",
  "url": "https://bao.example.org/mcp",
  "headers": { "X-Vault-Token": "${OPENBAO_TOKEN}" }
}
```

#### A cortex / cerebro memory-bank wrapper

Artemis already gives runs read access to configured memory banks as extra
directories (Settings → Memory banks), and that needs no server. A tool server
is what you want when the model should be able to *search and file* memories
through the CLI rather than read files. There is no published server for this;
you write a small wrapper that exposes `cerebro` over MCP. Needs **your wrapper
script and the `cerebro` CLI**:

```json
{
  "name": "cortex",
  "transport": "stdio",
  "command": "python3",
  "args": ["/Users/you/bin/cerebro-mcp.py", "--bank", "cortex"],
  "env": { "ARTEMIS_ROOT": "${HOME}/Library/Application Support/Artemis" }
}
```

Two warnings, both learned the expensive way. A wrapper that shells out to
`cerebro` is a tool server that can run a command, which on Windows is the one
thing the `shell` tool refuses — so give the wrapper a fixed argv rather than
letting the model pass one. And a bank write is a git commit and a push; mark
the read tools `readOnlyHint: true` in your wrapper so plan mode can use them,
and leave the write tools unmarked so they keep asking.

### What happens when a server is not there

Nothing fatal. Each server is connected concurrently with a fifteen-second
ceiling; one that fails becomes a line in the transcript naming it and the run
continues with the tools it does have. A tool server that vanished quietly would
leave the model insisting it has no way to do something it was told it could.

---

## 3. `http_fetch`

A built-in tool, performed by Artemis, offered under the same permission gates
as `write_file`.

```
http_fetch(url, method?, headers?, body?)
```

* `GET` and `POST` only.
* At most 5 redirects, and the hop is re-checked against the private-network
  rule below — an open redirect to `169.254.169.254` is a real technique, not a
  hypothetical one.
* At most 30 seconds and 2 MB. Truncated with a stated count rather than
  silently.
* HTML comes back as readable text: script, style, head and comments removed,
  tags stripped, whitespace collapsed. JSON and plain text come back as they
  are.
* A non-2xx response is a *result*, not an error — the status and the body are
  handed to the model, which is what lets it read a 404 and try another path.

### Private addresses

The rule is the permission mode:

| Mode | Loopback, RFC1918, link-local, `.internal`, tailnet CGNAT |
| --- | --- |
| `plan` | tool not offered at all |
| `default` | **allowed** — every call is approved by hand anyway |
| `acceptEdits` | **allowed** |
| `bypassPermissions` | **allowed** |

…with one exception that is never allowed in any mode: the cloud metadata
addresses (`169.254.169.254`, `metadata.google.internal`, `fd00:ec2::254`).
Those exist only to hand out credentials, and no run has a legitimate reason to
read them.

Private addresses are allowed rather than blocked because of who this feature is
for: a local model on a homelab, whose useful endpoints are a Home Assistant on
a LAN address and a handful of services on a tailnet. A tool that refused those
would be a tool that could reach the public internet and not the user's own
machines, which is precisely backwards. The gate that matters is the approval
prompt, and in `default` mode there is one per call.

---

## 4. Steering a local run

`midRunSteering` is now `true` for local profiles, so the composer stays usable
while a run is live. What that means here specifically:

* The message is **queued**, not injected mid-completion. There is no way to
  amend a request already streaming.
* It is delivered at the next **turn boundary**: after the current round of tool
  calls, or at the end of the turn if the model was already writing its answer.
  Delivery emits `message.delivered`, which is what takes the "Queued" chip off
  the row and the count off the composer strip.
* A message delivered at the end of a turn **continues** that turn rather than
  ending it, and resets the tool-round budget. The ceiling exists to stop a
  small model looping; a human typing is the strongest available evidence that
  the run is not looping.
* Stopping the run drops anything undelivered. `interrupt` reports
  `stillQueued: []` because that is true: nothing survives the abort.

---

## Where the code is

| Concern | File |
| --- | --- |
| The loop, and where a queued message enters it | `packages/core/src/adapters/local/loop.ts` |
| Tool definitions and dispatch | `packages/core/src/adapters/local/tools.ts` |
| `http_fetch` | `packages/core/src/adapters/local/httpFetch.ts` |
| The MCP client | `packages/core/src/adapters/local/mcp.ts` |
| Run wiring, approvals, steering queue | `packages/core/src/adapters/local/adapter.ts` |
| The config shape and its rules | `packages/protocol/src/toolServer.ts` |
| Where the servers are handed over | `apps/desktop/main/index.ts`, `apps/desktop/main/engine.ts` |
