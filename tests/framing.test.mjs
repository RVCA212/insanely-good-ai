import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDecoder, encode } from '../host/lib/framing.mjs'

test('decodes messages split across chunks and joined in one chunk', () => {
  const got = []
  const decode = createDecoder((m) => got.push(m))
  const frames = Buffer.concat([encode({ a: 1 }), encode({ text: 'héllo' }), encode({ b: [2] })])
  decode(frames.subarray(0, 3))
  decode(frames.subarray(3, 20))
  decode(frames.subarray(20))
  assert.deepEqual(got, [{ a: 1 }, { text: 'héllo' }, { b: [2] }])
})

test('the length prefix counts bytes, not characters', () => {
  const frame = encode({ t: 'é' })
  assert.equal(frame.readUInt32LE(0), frame.length - 4)
})
