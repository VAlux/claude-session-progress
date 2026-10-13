# Work-left countdown (ETA) — design

Date: 2026-10-13 · Status: approved in brainstorming, awaiting spec review · Target release: 0.2.0

## Goal

Every long turn's band shows how much work is left and when it should finish, as a countdown that tightens as the turn goes, including turns with no task list or plan. Today such a turn's bar is an unlabelled sweep: there was no honest percentage to show. This design gets an honest one from Claude itself.

Success: the countdown is shown only when it rests on a report of the work left, it gets closer to the truth as items finish, and the summary shows how far off the first estimate was, so its accuracy can be judged on real turns.

## Decisions

| Decision | Why | Rejected |
| --- | --- | --- |
| Claude reports the work left through a tool of the mod's own, `progress`. | Without a plan only Claude knows what is left. A countdown that converges needs that knowledge arriving as the work goes. | An ETA from past turns alone: turn lengths are heavy-tailed, so the expected time left *grows* with the time spent and the estimate recedes instead of counting down. Keeping the mod passive (observe only), for the same reason. |
| Items are sized `s`/`m`/`l`, or name the command they `run`. | One item can take 20 times another. Long commands are timed by the mod, so their estimate is measured, not guessed. Model rounds per size are learned. | Minutes reported by Claude (a model's sense of its own wall-clock time is poor). Unsized items (one rate for all, too coarse). A kind per item for every activity (more ceremony, slower to learn, no gain where the size already says it). |
| History stores rounds, the current turn supplies the seconds per round. | A slower model or a higher effort changes the pace, not the history. | Storing seconds per item. |
| The bar never moves back. | Early estimates are revised often; a bar going back reads as a fault. The countdown carries the truth. | Fill = done ÷ (done + left). |
| Nothing is estimated before Claude's first report. | Every estimate on screen rests on a report. | A muted "usually 3–9 min" range from history. |
| Task lists and plans get the same countdown, and their bar follows it. | One rule for every turn; the `x/y tasks` count stays exact. | Keeping done ÷ total for planned turns. |

## 1. The `progress` tool

### Registration

At `session.start`, when the `eta` setting is `on`, the mod calls `$.tool.register` with name `progress` (the model sees `mcp__session-progress__progress`) and `isDeferred: false`, so the tool sits in the prompt's tool list rather than behind ToolSearch. A session reloaded mid-turn registers it again (a name registered again is replaced). Its calls are served by a `tool.call` hook of their own, on `{ tool: 'mcp__session-progress__progress' }`, which answers without calling `next`; the existing observer hook skips the tool.

### Input

```json
{
  "type": "object",
  "properties": {
    "left": {
      "type": "array",
      "maxItems": 30,
      "items": {
        "type": "object",
        "properties": {
          "do":   { "type": "string", "description": "The item, in a few words" },
          "size": { "type": "string", "enum": ["s", "m", "l"] },
          "run":  { "type": "string", "description": "The exact command, when running it is the item" }
        },
        "required": ["do"]
      }
    },
    "done": { "type": "integer", "minimum": 1, "description": "How many items at the top of the list are finished" }
  }
}
```

- `left` is the whole remaining list, in order, the item Claude is on first. It replaces the previous list.
- `done: N` marks the top N items finished and leaves the rest. It costs about 10 output tokens where resending the list costs about 80, and it marks exactly when the top item ended.
- A call with both: `left` wins and `done` is ignored. A call with neither changes nothing.
- An item with neither `size` nor `run` counts as `m`. With both, `run` wins.
- `left: []` means only the closing answer is left.
- The handler trims `do` to 80 characters, keeps the first 30 items, and ignores unknown fields and wrong types item by item.

### Tool description (what Claude reads)

> Reports the work left in this turn, for the progress display only. List the items in order, the one you are on first. Give each a size: s — a quick change or lookup, about 1–2 tool calls; m — a few files or a few rounds, 3–8; l — a broad change or a debugging loop, 9 or more. When running a command is the item (a test suite, a build), give `run` with the exact command instead of a size. Send `{done: 1}` when you finish the top item; send `left` again when the list changes. Returns `ok`.

### System-prompt line

Added by the existing `prompt.compose` hook as its own section (`session-progress:eta`) when the tool is in `e.tools`, next to the task-list line:

> During work that will take more than a few steps and has no task list, report what is left with mcp__session-progress__progress. Start as soon as you have a rough idea, even a guess; exploring counts as an item. Keep the item you are on first. Send {done: 1} when you finish it and send `left` again when the work changes. Always send it in the same response as your other tool calls, never on its own. It only feeds the progress display.

### Handling a call

- Permission: a `tool.check` hook answers `{ decision: 'allow' }` for this tool, so it never prompts.
- Result: `ok`. Claude never sees the estimate.
- The call is left out of the tool-call counts, `byTool`, the counts `shouldShow` uses, `running`, `lastActivity` and the details' call list.
- A `ui.render` hook draws nothing for this tool's `ToolUse` and `ToolResult` rows.
- A failure inside the handler still returns `ok`: its `.catch` answers `ok` too, since a call no hook answers fails.

### Subagents

A subagent whose tool list has the tool reports the same way, into its own `AgentRun.work`; its band shows its own countdown, as its own task list drives its own bar today. A subagent whose agent definition lists its tools explicitly will not have it.

### Precedence

A Progress list reported in this turn drives the estimate. Otherwise a task list does, then a plan file, as today. The rows under the bar and the `x/y` count keep following a task list or plan when one exists; Progress items are listed only when neither does.

## 2. The estimator

Pure functions in a new `hooks/eta.ts`, called on each report, each round's end and the band's one-second tick.

### Rounds and pace

- A **round** is one model request (`turn.step`) and the tool calls it issued. Its wall time runs from its step's start to the next step's start.
- **Pace** is the median wall time of the turn's (or the subagent's) completed rounds, leaving out rounds that ran a Bash command equal to a `run` item's command (that time is the item's). With no completed round yet, it is the first step's model time.
- A **round-equivalent** is a duration divided by the pace at that moment.

### Samples

Each kind keeps a list of samples:

| Kind | Unit | Seeded with (round-equivalents) |
| --- | --- | --- |
| `s` | round-equivalents | 1, 1.5, 2, 3, 4 |
| `m` | round-equivalents | 3, 4, 5, 7, 10 |
| `l` | round-equivalents | 8, 10, 12, 18, 25 |
| task, plan task, plan step | round-equivalents | the `m` seeds |
| a command, per project | milliseconds | none |

Seeds are constants at the top of `eta.ts`. Real samples push them out (each list keeps its last 50; a command its last 10). Percentiles p20, p50, p80 are interpolated linearly over the sorted samples.

### Correction *c*

*c* = (A + 10) ÷ (E + 10), where A is the actual and E the estimated round-equivalents of the sized items and tasks finished so far in this turn (E: the median its kind had when the item reached the top). It is 1 at the start and leans toward this turn's real ratio as items finish; the 10 is about two `m` items' weight. It scales sized items and tasks, not `run` items.

### One item

| Item | Median | Low – high |
| --- | --- | --- |
| sized | p50 × pace × *c* | p20 × pace × *c* – p80 × pace × *c* |
| `run`, 5 or more runs | the command's p50 | p20 – p80 |
| `run`, 1–4 runs | the command's p50 | p50 ÷ 2 – p50 × 2 |
| `run`, never run | as `m` | as `m` |
| task, plan task, plan step | its kind's p50 × pace × *c* | p20 – p80, scaled the same |

### The item in progress

With *s* the time spent on it (since it reached the top of the list; for a `run` item whose command is running, since the command started):

- *s* below its median: remaining = median − *s*; low = max(0, low − *s*); high = high − *s*.
- *s* at or past its median: remaining = the median of its samples longer than *s*, minus *s*; low and high are those samples' p20 and p80 minus *s*. A sized item's or task's samples are compared in milliseconds, each × pace × *c*.
- *s* past every sample: remaining = max(*s* ÷ 4, pace); low = remaining ÷ 2; high = remaining × 2.

Every task in progress counts as an item in progress.

### The total

- R = the time remaining on the items in progress + the medians of the rest + one pace for the closing answer.
- low = R − √Σ(median − low)², high = R + √Σ(high − median)², over all items; low is at least one pace.
- While subagents the main turn started are running (during the turn, or in the *Waiting for N subagents* state after it), the main R, low and high are the largest of its own and theirs. If any of those subagents has no estimate, neither has the main turn.

### No estimate

The estimator returns none, and the label is empty, when:

- nothing has been reported (no Progress list, task list or plan);
- a subagent the main turn waits on has none;
- the item in progress is past its high and no report has come in the last 8 rounds (stale), until the next report. A report is a `progress` call, or a change to the task list or the plan file;
- any value is not finite, or R is not positive.

### The fill

- At the first estimate: fill = elapsed ÷ (elapsed + R).
- Each tick: dt = min(now − last tick, 5 s); fill += (1 − fill) × min(1, dt ÷ R); fill = min(fill, 0.97). It moves at the speed that reaches the end when the countdown does, slows when the work grows, and never goes back.
- With no estimate, the fill holds.
- The terminal's frame loop eases the drawn bar toward the fill, as it eases toward a plan's progress today; the desktop draws the fill.
- When the turn ends, the existing finish animation takes it from the fill to its end state.

### Learning

At each item's end, within the turn's in-memory history:

- A sized item finishes (`done`, or it is gone from the top of a new `left`): its wall time ÷ the pace goes to its size. Items that leave the list from lower down are dropped, not recorded.
- A task: from `in_progress` (or, for a plan task or step, from the previous one's completion or the first estimate) to completed, ÷ the pace, goes to its kind.
- Every Bash call that ran in the foreground (not `run_in_background`), finished or failed, goes to its command's samples under the session's project, whether an item named it or not. Commands are matched after trimming, collapsing whitespace and dropping a leading `cd <dir> &&`, and cut to 200 characters.
- An interrupted or failed turn records nothing for its unfinished items.

## 3. The band

```
⠋ Fix the tokenizer edge case                          2/5 items · 1m 20s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────────── ~4m left (3–6m)
⚒ 14 tool calls  ✎ 3 files +42 −7  ⌕ 6 read  ↻ 9 steps  ⇅ 120k↑ 4k↓ · $0.41
  ✓ find where the tokenizer splits words
  ◐ fix the tokenizer edge case                                         ~2m
  ○ run the parser tests                                                ~3m
  ○ update the README table                                            ~30s
```

### The label

The countdown replaces the percentage as the bar's label.

| R | Label |
| --- | --- |
| 2 min or more | `~4m left`, whole minutes, rounded; the range `(3–6m)` follows, low rounded down and high up, unless they are the same minute |
| 10 s to 2 min | `~1m 30s left` or `~40s left`, in steps of 10 s; no range |
| under 10 s | `a few seconds left` |

- On the terminal, the first of these that leaves the bar 20 cells or more is drawn: the full label, the label without its range, the value alone (`~4m`). The desktop draws the full label.
- When the shown value grows by one unit or more, an amber (`WARN`) `↑` follows it for 5 s.
- With no estimate the label is empty, as today; the bar's shimmer keeps moving.
- On the desktop the label is the SVG bar's label, where the percentage goes today.

### The head row and the rows

- The headline is the item in progress, first letter capitalised, where a task in progress shows today.
- The count reads `2/5 items`: finished and left, so it grows when work is added.
- Progress items are listed under the bar as a plan file's steps are, under `stepRows` `auto` and `always` (not `never`): ✓ finished this turn, ◐ in progress, ○ to do, up to the existing 5 rows. Each row ends with its estimate, dimmed: the time left on the item in progress, the median on the others, in the label's format without `left`.
- Task lists and plan files get the countdown on their bar; their rows are unchanged.
- A Progress list of 2 or more items counts as a plan for when the band appears (8 s rather than 20 s).

### Subagents

A subagent's band shows its own countdown. The main band, while it waits on subagents, shows the combined one (section 2, the total).

### The summary

When the turn ended with an answer and had an estimate, one line:

```
⏱ at 1m 20s: estimated ~6m more (3–9m) · took 6m 20s more
```

The first estimate against what followed. It compares time left, not total time, so it does not repeat Claude Code's `Brewed for …` line.

### Setting

`userConfig.eta` in `plugin.json`: `on` (default) or `off`. `off` registers no tool, adds no prompt line, records no history and draws no countdown; the band then behaves as 0.1.9 does.

## 4. Storage

`$.store`: one JSON file of the mod's own under the Claude Code configuration directory, shared by every session, at most 4 MiB.

| Key | Holds | Bound |
| --- | --- | --- |
| `eta.sizes` | `{ s, m, l, task, planTask, planStep }`: sample lists in round-equivalents, shared across projects | 50 each |
| `eta.commands` | `{ [project root]: { [command]: { samples, lastUsed } } }`, the project from `$.session.root()` | 10 runs per command; 100 commands per project and 50 projects, least recently used dropped first |
| `eta.log` | One row per turn with an estimate: `{ at, firstAtMs, estimatedMs, lowMs, highMs, tookMs, source }`, `source` being `progress`, `tasks` or `plan` | last 200 |
| `eta.version` | `1` | — |

- Read once at `session.start` into a module cache. A missing, unreadable or other-version store means the seeds.
- Written once per turn, at `turn.complete`: for each key, read it again, merge this turn's samples in, write it, so two sessions at once do not drop each other's samples.
- The worst case, all bounds full, is about 0.7 MiB.

### State contract (`types/index.d.ts`)

- `WorkItem = { do: string; size?: 's' | 'm' | 'l'; run?: string }`.
- `Work = { items: WorkItem[]; finished: string[]; topSince: number }`: one turn's (or run's) Progress list, what finished, and when the top item got there.
- A `work` atom for the main turn, cleared at `turn.start` (a Progress list does not carry over, unlike a plan); `AgentRun.work?: Work` for a subagent.
- `Live.eta?: { firstAtMs: number; first: { ms: number; lowMs: number; highMs: number }; fill: number; lastTickAt: number; lastReportRound: number; actual: number; estimated: number; shownMs: number | null; upUntil: number | null }`, set at the first estimate: the summary's first estimate, the fill, the round of the last report (for the stale rule), the sums *c* is made of, and what the `↑` compares. In state, so the desktop band and a band collapsed and reopened draw the same fill.
- `StepRecord.startedAt?: number`, for each round's wall time; `CallRecord.command?: string`, a Bash call's matched command, to leave `run` rounds out of the pace. Both absent on records kept from before they existed.
- `Summary.eta?: { atMs: number; estimatedMs: number; lowMs: number; highMs: number; tookMs: number }`.
- `AgentRun.eta?` as `Live.eta`.

## 5. Error handling

- The store: a failed read means the seeds; a failed write (over 4 MiB, say) prunes harder (halves each bound) and tries once more, then drops the turn's samples. Neither blocks the turn.
- The estimator: anything not finite, or a non-positive R, is no estimate (section 2).
- A gap between ticks (a laptop asleep) moves the fill at most 5 s worth.
- Claude stops reporting: the stale rule drops the estimate (section 2).
- An interrupted or failed turn records no sample for its unfinished items and gets no summary line.
- A hot reload mid-turn: the atoms survive; the cache is read again from the store, and the samples the turn had gathered but not yet written are lost.
- The tool handler never fails a call (section 1).

## 6. Testing

Behaviour tests, run with `claude plugin test`, using the testing kit's mock clock and mock store.

| File | Covers |
| --- | --- |
| `tests/eta.test.ts` | The pure estimator: medians and ranges from the seeds; pace, leaving out `run` rounds; *c*; the three in-progress cases; the root-sum-square range narrowing as items finish; the combined estimate with subagents; each no-estimate case; the fill (first value, never back, the 97% cap, holding, the 5 s cap); the label formats and their shortening |
| `tests/report.test.tsx` | The tool: registered at `session.start`, not deferred; `tool.check` allows it; it returns `ok`; clamping; `left`, `done`, both, neither; not counted anywhere; the prompt line only when the tool is listed; `eta: off` removes all of it |
| `tests/eta-band.test.tsx` | The label on the terminal and the desktop; the `↑`; Progress rows under each `stepRows`; precedence with a task list; a subagent's countdown; an empty label while waiting on a subagent with none; the summary line |
| `tests/eta-store.test.tsx` | Samples written at turn end; re-read and merge; the bounds; a corrupt or other-version store; command matching; projects kept apart |

Existing expectations in `tests/plans.test.tsx` and `tests/progress.test.tsx` that read a planned bar's percentage change on purpose: the bar follows the countdown now.

Manual run with `claude --plugin-dir` on a real multi-step task, in the terminal and in the desktop app.

## 7. To verify first

These are API assumptions the tests cannot prove. Check them before building on them; if one fails, stop and revisit the design.

1. A `tool.check` hook's `allow` runs the mod's own tool with no permission prompt, in the default permission mode.
2. With `isDeferred: false` the tool is in the main loop's tool list, not behind ToolSearch.
3. A subagent with all tools has the tool, and `prompt.compose` runs for its prompt (so it gets the line).
4. A `ui.render` hook can draw nothing for one tool's `ToolUse` and `ToolResult` rows.
5. A `tool.call` hook can answer a registered tool's call without `next`, and Claude reads `ok`.

## 8. Docs and release

- README: the "Neither" row of *How progress is measured* becomes the Progress tool; the countdown and the summary line in *What it shows*; `eta` in *Settings*; the cost of reports (tens of output tokens each) and the store in *Good to know*.
- `plugin.json`: the `eta` setting; version 0.2.0.

## Out of scope

- An estimate before Claude's first report.
- Kinds for items other than `run` (explore, edit, check); add them later as an optional field if the log shows sizing is where the error is.
- Sizes for task-list or plan tasks.
- A view of what an estimate is made of (samples, pace, *c*).
- Showing the estimate to Claude.
