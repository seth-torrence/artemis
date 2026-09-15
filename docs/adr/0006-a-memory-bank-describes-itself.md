# A memory bank describes itself, and Artemis reads it

Decided 2026-09-15, while the second team bank was being laid out in a shape
the first one's tooling could not read.

Memory banks were driven by the `cerebro` CLI: a Python script embedded in
each bank, vendored by Artemis for bootstrap, and run by a session-start hook.
The CLI knew two layouts and hard-coded the folder name of one of them at ten
sites. A bank that wanted a third shape — brand first, then system, instead of
org then project — needed a CLI patch, and the patch had to be copied into
every bank and into Artemis before any machine could read the bank. The hook
bound each profile to whichever bank's copy had last run `enable`, so a stale
copy skipped a bank silently. Nothing read the installed memories but Claude
Code's own auto-memory, so a local-model or Codex profile never saw a bank at
all. And the prompt teaching the banks had one scope while the banks
themselves had none.

Three ways out were available.

**Keep the CLI as the reader and give it a plugin per layout** was rejected
because it keeps every cost that hurt: Python on the read path of a Windows
machine, three copies of one script with no version negotiation, and a hook
that can only bind one of them. **A memory service with a database behind
it** was rejected because the banks are reviewed like code — a pull request,
a diff, a merge — and that is the property the team values most; Letta moved
its own memory from database blocks to git-backed markdown in 2026 for the
same reason. **Making Artemis the host** is what was chosen.

So a bank describes itself in one file, `BANK.md`: the frontmatter says where
its entries are (a glob), what its folder names mean (a scope template), what
an entry must contain (a schema, `cerebro` by default), where a new entry is
filed and how it lands; the body is the bank's instructions to agents. A bank
with no manifest is read as a legacy `cerebro` bank, flat or by project,
with no change to its repository — the format is detected, and each format is
an adapter that produces the same model. Core reads, validates, installs and
describes a bank in TypeScript; the CLI is no longer on the path of any run.
Banks attach to profiles — every profile, or a chosen set — in a registry
Artemis owns, and the one built-in prompt is rendered per run from the banks
the run's profile carries. The installed layout and the marked block in
`MEMORY.md` are kept byte-compatible with the CLI's, and the CLI's own
registry is mirrored after every write, so a machine that also runs stock
Claude Code with the CLI keeps syncing the same banks, and a team on the
legacy shape keeps working without knowing any of this happened.

Two consequences are worth naming. The index a project's memory file carries
is now budgeted, because the harness that loads it stops reading at two
hundred lines, and a bank that lists everything is a bank whose tail nobody
reads. And writing moves in a second step: agents will draft, promote and
retire through memory tools Artemis exposes to every session, which is what
makes a bank reachable from a provider that has no shell and no Python; until
those land, a legacy bank that embeds the CLI is still taught its commands.
