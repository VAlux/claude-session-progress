# session-progress

A Claude Code mod that shows how a long-running task is going, in an animated band just above the prompt. When the task finishes, it shows a short summary of what was done.

- **Only for long tasks.** Quick answers and short Q&A never show the band. It appears after 20 s with at least 3 tool calls, after 8 s when there is a task list or plan of 2 or more steps, or after 45 s regardless.
- **Real progress when the steps are known.** When Claude keeps a task list (`TodoWrite`, or `TaskCreate`/`TaskUpdate`), the bar shows completed ÷ total, and the steps are listed with ✓ / ◐ / ○. When Claude works from a Markdown plan with `- [ ]` / `- [x]` checkboxes, the bar follows the boxes as they are ticked. With neither, a soft streak sweeps the track instead of a made-up percentage.
- **Live details.** The step Claude is on now, elapsed time, tool calls, subagents, files changed, model steps, tokens, errors, and the calls running right now.
- **A summary at the end.** The bar fills and turns green (amber if interrupted, red on an error), followed by duration, work done, tokens in and out with the cache share, the model, the most-used tools, and totals for the session. Your next prompt hides it.
- **Asks for a task list on multi-step work.** It adds one line to the system prompt asking Claude to keep a task list when a task has several known steps, so the bar has real steps to follow.

It draws in the terminal only. Collapse the band at any time with `ctrl+x ctrl+a` or the `[-]` mark.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-progress --marketplace VAlux/claude-session-progress
```

Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session). It starts working in that session right away.

## Develop

```sh
git clone https://github.com/VAlux/claude-session-progress
claude --plugin-dir ./claude-session-progress   # load it from the working copy for one session
claude plugin validate ./claude-session-progress
claude plugin test ./claude-session-progress
```

The thresholds for when the band appears are the constants at the top of `hooks/register.tsx`.

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks: turn and tool tracking, the system-prompt line, the band |
| `hooks/frames.ts` | Bar and spinner frames, the checkbox parser, formatting |
| `types/index.d.ts` | The mod's state contract |
| `tests/` | Behaviour tests, run with `claude plugin test` |

The mod uses Claude Code's function-hooks plugin API, which is in early access and may change between releases.

## License

MIT
