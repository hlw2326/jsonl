import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Jsonl } from '@hlw2326/jsonl'

const require = createRequire(import.meta.url)

test('ESM 与 CommonJS 入口均导出 Jsonl', () => {
  assert.equal(typeof Jsonl, 'function')
  assert.equal(typeof require('@hlw2326/jsonl').Jsonl, 'function')
})
