# A suggested task is a tool call, and the transcript is its storage

Decided 2026-09-09, adding the follow-up chips an agent offers at the end of a
turn. Three mechanisms were available and only one of them keeps the offer
alive across a reload.

**Parsing prose** — a tag or JSON block the model emits in its answer — was
rejected because it makes every answer a parsing surface. The block has to be
stripped from what the reader sees, it flickers into view mid-stream, and a
model that mentions the tag while explaining it produces a chip. **A side
channel** — a push like `RunSuggestion`, which Artemis already has for the
predicted next prompt — was rejected because nothing on it is stored: the
prediction is generated after `run.end`, arrives outside the event stream, and
is correctly thrown away when the window closes. An offer of work is not a
prediction; it is part of the record of what the agent said.

So the agent offers a task by **calling a tool Artemis hands it**,
`mcp__artemisTasks__suggest_task`, whose handler does nothing but return a
sentence. The provider files the call in its own transcript, a reopened
conversation replays it as `tool.start` / `tool.end`, and the chips come back.
Artemis stores nothing, which is what makes it impossible for Artemis to lose
them or to disagree with the file. The transcript model keeps the call out of
the activity fold — an offer is not machinery — and the renderer draws it as a
chip instead of a tool card.

Two consequences were accepted rather than worked around. The tool call is
**auto-allowed** in the Claude adapter, because a permission prompt in front of
a suggestion teaches people to click through prompts and there is nothing to
weigh. And the feature is **gated on `Capabilities.taskSuggestions`**, which is
true only for a provider that can be handed a host tool: Claude has it, Codex,
OpenCode, the local OpenAI-compatible servers and a served Artemis Server
connection do not, and those conversations show no chips at all rather than a
control that could never appear.

Where a chosen task runs is the **user's** choice, never the model's: this
session, a new one, a git worktree, or a server. That is why the tool is called
`suggest_task` and not `spawn_task`, and why it takes no working directory.
