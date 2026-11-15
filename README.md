# Cockpit

A supervision pane for Claude Code: it shows what your AI agents are doing, how much they are using, and which code edits have not been tested since.

Cockpit is a personal tool, built for my own use. It is shared here as a portfolio piece, not as a supported product.

## Why

When Claude Code works for several minutes, or several sessions run at once, three things are easy to lose track of:

- what each agent is doing right now, and which session is waiting for a decision from me;
- how much of the context window and of the usage allowance is left;
- whether code was changed after the last time anything was tested. A green "Done" at the end of a long turn says the agent stopped, not that the work was checked.

Cockpit puts these three things in one place next to the conversation.

## What it does

- **Live pane** beside the chat: what Claude is doing, tool and agent counts, a visible "waiting for you" state when a permission or a question is pending.
- **Usage meters**: context against the compaction point, and the 5-hour and 7-day usage windows with a projection to the reset.
- **Proof line**: code edits made since the last successful test, build, type check or lint run, subagents included. It recognises checks from the text of the command and only counts an exit code of 0. The pane states that a tick is an exit code, not proof the work is right.
- **Activity, Steps and Plan**: running agents and workflow agents, the session's task list, and a superpowers plan band above the prompt.
- **Sessions**: the other Claude Code sessions open on the machine and which of them wait for you.
- **Project tabs**: files read or changed, a read-only Git view, and a Learn tab that keeps the "Insight" notes and the terms Claude explained.
- **Pins and notes**: pin a reply with `/pin`, keep a scratchpad per project.
- **Alerts**: a macOS notification and one sound per kind (long turn finished, Claude waiting, build or tests failing, usage above 80%).
- **Chat-style transcript**, an end-of-turn line with duration and API-priced cost, sensitive tool calls (delete, push, SQL, deploy) marked in red, and a colour theme.

The pane's interface is in English. Some comments, test data and the original design notes are in French.

## How it was built

I designed Cockpit and steered the work. I do not write code myself: every line was written by Claude Code under my direction.

My part was the specification and the decisions: what a supervisor needs to see, which signals can be trusted, and which must be labelled as only indicative. For example, a tick means "exit code 0", never "correct", and the sensitive-action markers are visual cues, not a protection.

The method had four parts:

1. **Audit first.** Before changing anything, I had the supervision setup (this pane and the terminal) audited against one criterion: does it help me supervise my agents better? The audit report describes my own sessions, so it is not published.
2. **Seven workstreams.** The improvements chosen from the audit were each built on their own branch, then reviewed by an independent agent that had not seen the work, corrected, and merged.
3. **Tests.** The repository holds an automated test suite, run with `claude plugin test`, plus the plugin validator (`claude plugin validate`).
4. **Real-session driver.** `dev/drive.py` starts a throwaway Claude Code session in a pseudo-terminal with the mod loaded, types prompts and reads the screen, so that what the pane draws can be checked without clicking by hand.

## Results and status

Cockpit is a working prototype, installed in my own Claude Code setup. Its only review so far is the independent agents mentioned above; it has had no outside review.

What was checked for this public copy, on Claude Code 2.1.325 on 2026-11-15:

- `claude plugin test .`: 191 tests, 191 pass, 0 fail.
- `claude plugin validate .`: passes, with warnings (no author field, no icon, no marketplace install line). It reported no type errors.

Limits and things not proven:

- **No evidence of effect.** I have not measured whether Cockpit makes supervision better or catches mistakes earlier. It is a tool I built because I wanted it.
- **Heuristics.** Check detection reads command text, not what the command did. A command that hides its exit code shows as unknown, and an unusual tool name is missed. Edits made through shell commands (`sed`, scripts) are not counted.
- **macOS and Ghostty only.** Sounds, notifications, opening links and the "Fork" and "go" buttons use macOS tools and the Ghostty terminal. I did not test any other setup.
- **Depends on Claude Code internals.** It uses the plugin interface of Claude Code 2.1.x (hooks modules that draw panes). That interface may change, and I only ran it on the version above.
- **Some actions were not exercised in a real session** when I last documented them: the second press of the delete button on stale sessions, and the "go" button on a session that is open in a tab. The tests cover them with simulated tools.
- **Notes export is tested only with the test kit.** The optional export to a Markdown note (below) is covered by tests, but I did not try it in a live session after making it configurable.
- This public copy was cleaned of personal paths and names, which changed the notes export and some test data. Those changes are checked by the tests above, not in a live session.

## How to run

Requirements: [Claude Code](https://claude.com/claude-code) (a version with plugin support, 2.1.325 was used here), macOS, and a wide terminal in fullscreen mode (`tui: fullscreen`) for the side pane.

Cockpit is a Claude Code plugin. Clone the repository and load it from the folder:

```bash
git clone https://github.com/antoinevoinchet-spec/cockpit.git
claude --plugin-dir ./cockpit
```

In the session, `/cockpit` opens the pane and `/pin` pins the last reply. `/theme` offers the "Claude · Ghostty" colour theme.

To check the code:

```bash
cd cockpit
claude plugin validate .
claude plugin test .
```

Optional settings, declared in `.claude-plugin/plugin.json` as plugin options:

| Option | Default | Effect |
|---|---|---|
| `notesDir` | empty | Folder where the Learn tab appends the "Insight" points as a Markdown note. Empty: the export is off. |
| `notesName` | `Claude Code learnings` | Name of that note, without `.md`. |
| `obsidianVault` | empty | If set, adds a button that opens the note in that Obsidian vault. |

Other settings (alert delay, sounds, pane width, editor list) are constants at the top of `hooks/register.tsx`.

To look at the pane in a throwaway session (the driver's own notes put a prompt at about a cent with Haiku; use `--bin` if `claude` is not in `~/.local/bin`):

```bash
python3 dev/drive.py "Reply with one word: hello"
```

## Repository layout

```
.claude-plugin/plugin.json   manifest and plugin options
hooks/register.tsx           the pane, band, alerts and transcript (entry point)
hooks/*.ts                   colours, labels, sessions, git graph, status checks, plan, pins
tests/cockpit.test.tsx       the test suite
themes/                      colour theme
types/index.d.ts             shared types
dev/drive.py                 driver for a throwaway Claude Code session
```

## Licence

Copyright (c) 2026 Antoine Voinchet. All rights reserved. See `LICENSE`.
