// Chrome native messaging: each message is JSON with a 4-byte length in front (native byte order).

export function encode(message) {
  const body = Buffer.from(JSON.stringify(message))
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  return Buffer.concat([head, body])
}

/** Returns a function for stdin chunks. It calls onMessage once for each whole message. */
export function createDecoder(onMessage) {
  let buffer = Buffer.alloc(0)
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0)
      if (buffer.length < 4 + size) return
      const body = buffer.subarray(4, 4 + size)
      buffer = buffer.subarray(4 + size)
      onMessage(JSON.parse(body.toString('utf8')))
    }
  }
}
