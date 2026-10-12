import { expect, test } from 'claude-code/testing'

import { stepCost, usd } from '../hooks/frames'

test('a step costs its tokens at the model\'s list prices', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }
  // 2 fresh + 2.5 cache write + 0.2 cache read + 10 output
  expect(Math.round(stepCost('claude-sonnet-5-5', usage) * 1000) / 1000).toBe(14.7)
})

test('a model the table does not know costs nothing, and so does a step with no usage', () => {
  const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(stepCost('some-other-model', usage)).toBe(0)
  expect(stepCost('claude-opus-5-5', null)).toBe(0)
})

test('opus 5.5 is priced apart from the opus 5 family', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(Math.round(stepCost('claude-opus-5-5', usage) * 1000) / 1000).toBe(4)
  expect(Math.round(stepCost('claude-opus-5', usage) * 1000) / 1000).toBe(5)
})

test('dollars read with cents, one decimal from ten up, and a floor under a cent', () => {
  expect(usd(0.0004)).toBe('<$0.01')
  expect(usd(0.126)).toBe('$0.13')
  expect(usd(12.34)).toBe('$12.3')
})
