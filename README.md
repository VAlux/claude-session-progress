<div align="center">

# session-progress

**A live progress band for long Claude Code tasks, and a short summary when they finish.**

[![License: MIT](https://img.shields.io/badge/license-MIT-4eba65)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Surfaces: terminal, desktop](https://img.shields.io/badge/surfaces-terminal%20%7C%20desktop-5c5c5c)](#good-to-know)

<img src="docs/demo.gif" alt="session-progress following a six-step plan in Claude Code, then showing its details, the cost and the session total" width="900">

</div>

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-progress --marketplace VAlux/claude-session-progress
```

Answer `y` to add the marketplace, then pick a scope. The user scope loads it in every session. It starts working in the current session right away.

The desktop app's Code tab has no `/plugin` command. Install it from a terminal at the user scope, and the local sessions the desktop app starts load it too.

## What it shows

| | |
| --- | --- |
| **While Claude works** | A pulsing spinner and the step Claude is on, an animated bar, elapsed time, and a row of counts, each with its own icon: ⚒ tool calls, ⑂ subagents, ✎ files changed with the lines added and removed, ⌕ files read, ↻ model steps, ⇅ tokens with their estimated cost in USD, and ⚠ errors. Below them, what is running right now. |
| **When you click a count** | Its details open under the row (see [Details](#details)). Click it again to close them. |
| **When the steps are known** | The bar shows real progress, and the headline names the step in progress. A plan file's steps are listed under the bar with ✓ done, ◐ in progress and ○ to do. A task list's are not, because Claude Code already draws its own. |
| **When Claude hands off to a subagent** | A turn that ends while the subagents it started still run says *Waiting for N subagents*, not *Task complete*, and its bar stays where the plan is instead of filling. |
| **In a subagent's transcript** | Open a subagent from the tasks list and the band follows that subagent alone: its current task or activity, its own task list and bar, its tool calls, files, tokens and time. When it answers, the band says *Subagent complete*. A subagent the band never saw (one that started before the mod loaded) gets no band, rather than the main one's. |
| **When it finishes** | The bar fills and turns green, or amber if you interrupted it, or red on an error. The summary lists work done, tokens in and out with the cache share, the estimated cost of the task in USD, the model and the most-used tools, and, from the second turn on, one line of totals for the session, cost included. It leaves the turn's time to Claude Code's own closing line (`Brewed for 5m 59s`). |
| **On your next prompt** | The summary goes away. |

## Details

Each count under the bar is a button. Click it, or focus the band with `ctrl+x tab` and press Enter on it, and the band lists what is behind it. One list is open at a time, and it stays open across turns until you click the count again.

| Count | What it lists |
| --- | --- |
| ⚒ tool calls | A tally by tool, then the latest calls: ✓ done, ◐ running, ✗ failed (with why), and how long each took |
| ⑂ subagents | Each subagent the turn started: its description and type, its calls, output tokens and time, and what it is doing now |
| ✎ files | Each file changed, by name, with the lines added and removed (`a.ts  +12 −3`). Two files with one name show their folder too |
| ⌕ read | The files read, side by side |
| ↻ steps | Time spent in the model and in tools, then each model request: the tools it called, its tokens and its time |
| ⇅ tokens | The estimated cost, input split into fresh, cache read and cache write, output per step, the context at the last step, and the model |
| ⚠ errors | Each failed call, a subagent's marked with ⑂, and why it failed |
| ☰ tasks | In the summary: the task list or plan steps, with ✓ ◐ ○ |

The summary keeps the finished turn's details, so you can open them after the turn ends. Line counts come from each edit's own patch. A notebook edit, or a rewrite of a file too large to diff, has no line count, and its file reads `changed` instead.

## How progress is measured

| Source | What the bar shows |
| --- | --- |
| A task list (`TodoWrite`, or `TaskCreate` / `TaskUpdate`) | Done ÷ total, with the task in progress counting as half |
| A Markdown plan with `- [ ]` / `- [x]` boxes that Claude reads or edits | Ticked ÷ total, moving forward as boxes are ticked |
| A plan with two or more `### Task N:` headings | Done tasks ÷ total. A task is done when all its boxes are ticked, or when a superpowers ledger reports `Task N: complete`, whether in a Bash call's output (`task-done`) or in its `progress.md` that Claude reads. superpowers' executor never ticks a plan's boxes, so without this its plans stayed at 0%. |
| Neither | A soft streak sweeps the track. There is no honest percentage to show, so it does not invent one, and the bar carries no label: the clock is on the row above. |

A task list wins over a plan file. A plan that is still unfinished carries over to the next turn, and a finished one is cleared. A subagent's own task list never replaces the main one, but a subagent can still mark the main session's tasks done. Its own list drives its own band instead.

The mod also adds one line to the system prompt, asking Claude to keep a task list when a task has several known steps, so the bar has real steps to follow more often.

## When it appears

Quick answers and short Q&A never show the band. It appears once a turn has run:

| | |
| --- | --- |
| 20 s, with at least 3 tool calls | ordinary multi-step work |
| 8 s, with a task list or plan of 2+ steps | planned work, which shows sooner |
| 45 s | anything that runs long |

The thresholds are the constants at the top of [`hooks/register.tsx`](hooks/register.tsx).

## Settings

Change it in `/config`, or with `claude plugin configure session-progress`.

| Setting | Values | What it does |
| --- | --- | --- |
| `stepRows` | **`auto`**, `always`, `never` | When the band lists the steps under its bar. `auto` lists a Markdown plan's steps or tasks only, since Claude Code draws its own task list. `always` lists task lists too, and `never` lists nothing. |

To make the band your only task view, hide Claude Code's own list with `ctrl+t` and set `stepRows` to `always`.

## Good to know

- It draws in the terminal and in the desktop app. On the desktop the bar and spinner are vector drawings that animate themselves, and the finish lands at once instead of easing in. The VS Code extension and the mobile app have no band above the prompt, so they show nothing extra.
- Costs are estimates: each model step's tokens at Anthropic's list prices (the table at the top of [`hooks/frames.ts`](hooks/frames.ts)), subagents included. A model missing from the table adds nothing, and a plan's discount or a different provider's rate is not reflected.
- Collapse the band at any time with `ctrl+x ctrl+a`, or with the `[-]` mark at its right edge.
- A bug in the mod never blocks a tool call: its tool hook passes the call through if it fails.
- It shares the space above the prompt: another mod's band there (factory-floor's strip, say) is drawn above it, not hidden.
- It is built on Claude Code's function-hooks plugin API, which is in early access and may change between releases.

## Develop

```sh
git clone https://github.com/VAlux/claude-session-progress
claude --plugin-dir ./claude-session-progress     # load the working copy for one session
claude plugin validate ./claude-session-progress
claude plugin test ./claude-session-progress
```

| Path | What it holds |
| --- | --- |
| [`hooks/register.tsx`](hooks/register.tsx) | The hooks: turn and tool tracking, plan files, the system-prompt line, the band |
| [`hooks/details.ts`](hooks/details.ts) | What each count opens onto: the per-call, per-file and per-step records, line counting, and the detail rows |
| [`hooks/frames.ts`](hooks/frames.ts) | Bar and spinner frames (terminal cells, desktop SVG), the plan and ledger parsers, formatting |
| [`types/index.d.ts`](types/index.d.ts) | The mod's state contract |
| [`tests/`](tests) | Behaviour tests, run with `claude plugin test` |

The demo in [`docs/`](docs) was recorded with [VHS](https://github.com/charmbracelet/vhs) from [`docs/demo.tape`](docs/demo.tape).

## License

[MIT](LICENSE)
