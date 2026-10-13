// The `progress` tool Claude reports the work left with: its definition and the system-prompt line asking for it.

import type { ToolSpec } from 'claude-code'

/** The tool's short name, and the name the model calls it by. */
export const PROGRESS_NAME = 'progress'
export const PROGRESS_TOOL = 'mcp__session-progress__progress'

const DESCRIPTION =
  'Reports the work left in this turn, for the progress display only. List the items in order, the one you are on first. ' +
  'Give each a size: s — a quick change or lookup, about 1–2 tool calls; m — a few files or a few rounds, 3–8; ' +
  'l — a broad change or a debugging loop, 9 or more. When running a command is the item (a test suite, a build), ' +
  'give `run` with the exact command instead of a size. Send `{done: 1}` when you finish the top item; ' +
  'send `left` again when the list changes. Returns `ok`.'

/** The tool as the mod registers it: in the prompt's tool list, not behind ToolSearch, since a report there would cost a round. */
export const PROGRESS_SPEC: ToolSpec = {
  name: PROGRESS_NAME,
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      left: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            do: { type: 'string', description: 'The item, in a few words' },
            size: { type: 'string', enum: ['s', 'm', 'l'] },
            run: { type: 'string', description: 'The exact command, when running it is the item' },
          },
          required: ['do'],
        },
      },
      done: { type: 'integer', minimum: 1, description: 'How many items at the top of the list are finished' },
    },
  },
  isDeferred: false,
}

/** The system-prompt line asking Claude to report, when the tool is offered. */
export function etaLine(tools: readonly string[]): string | null {
  if (!tools.includes(PROGRESS_TOOL)) return null
  return (
    `During work that will take more than a few steps and has no task list, report what is left with ${PROGRESS_TOOL}. ` +
    'Start as soon as you have a rough idea, even a guess; exploring counts as an item. Keep the item you are on first. ' +
    'Send {done: 1} when you finish it and send `left` again when the work changes. ' +
    'Always send it in the same response as your other tool calls, never on its own. It only feeds the progress display.'
  )
}
