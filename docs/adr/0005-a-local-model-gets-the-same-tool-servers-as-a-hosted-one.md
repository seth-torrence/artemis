# A local model gets the same tool servers as a hosted one

Decided 2026-09-09. The local providers (LM Studio, Ollama, `llama-server`)
gain an MCP **client** of their own, and the host's `agentToolServers` factory
— the seam that builds `artemisBrowser` per run — is handed to them as well as
to Claude. A local run therefore calls
`mcp__artemisBrowser__browser_read` under the name a Claude run knows it by,
through the same decision table, with no second factory and no second set of
names.

The asymmetry this removes was never a decision. `packages/core` may not import
Electron, so a tool that drives a `WebContentsView` is built in
`apps/desktop/main` and injected — and only the Claude adapter had a hole to
inject it into. Everything downstream of that hole (the permission prompt, the
transcript's `mcp__` classification, the "always allow this tool" rules) already
worked for any adapter that could reach a server.

Three decisions follow, and each of them is a place where the obvious answer was
rejected.

**Tool servers are configured on the profile, not in a file a CLI reads.** A
Claude profile is a config directory, so a server named in `~/.claude` is found
by the binary Artemis spawns. A local profile is an *address*: `llama-server`
holds no configuration and would not read a file if there were one. So the list
lives beside `baseUrl` and the endpoint key, which are the other two facts of
exactly that shape. Rejected: a global `.mcp.json`, which would have given every
profile the same servers and no way to say otherwise; and reading the user's own
`~/.claude/settings.json`, which `settingSources: []` deliberately does not
inherit.

**Secrets are referenced, never stored.** `${NAME}` in any config string is
expanded from the run's environment at connect time, and a value that looks like
a literal credential is refused at the save button. `profiles.json` is
unencrypted and stays a file with nothing secret in it — the same rule
`publicEnv` keeps. Rejected: encrypting the tool-server list alongside the
endpoint key, which would have made the config write-only in the editor and
reproduced the exact bug that moved `baseUrl` out of `publicEnv`.

**`acceptEdits` does not cover a tool server, and does not reach a private
address.** That mode's bargain is "stop asking me about edits to this working
directory" — files the user is looking at, which git can undo. A tool server
acts on a repository, a vault or a live page; `http_fetch` on a private address
acts on the user's own network. Neither is an edit to this directory, so both
keep asking, and only `bypassPermissions` silences them. Rejected: treating
every non-`execute` tool as an edit, which is what the flag's original one-line
test did and which would have made "stop asking about edits" quietly mean "and
also act on my homelab".

Two things are deliberately *not* changed. The Windows shell refusal stands:
`commandSandbox.ts` still has no Windows backend, `shell` still refuses rather
than running unconfined, and neither addition routes around it — `http_fetch`
runs nothing, and a stdio tool server executes only a command a user wrote in
settings, never one the model composed. And `midRunSteering` becoming `true`
for local runs is a queue read at turn boundaries, not an injection into a live
completion; `send` reports `deliveredImmediately: false` because that is what
happened.

This closes F13 of
[the gap analysis](../research/OPENROUTER-GAP-ANALYSIS.md) for local profiles
only. Hosted providers still reach MCP through the runtime Artemis wraps, and
the settings field is offered only where it does something. See
[docs/LOCAL-MODEL-TOOLS.md](../LOCAL-MODEL-TOOLS.md).
