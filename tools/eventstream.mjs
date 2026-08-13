/**
 * Just enough vnd.amazon.eventstream to talk to Transcribe streaming:
 *   total length (4) | headers length (4) | prelude CRC32 (4)
 *   headers | payload | message CRC32 (4)
 */
import zlib from 'node:zlib'

const crc32 = buf => zlib.crc32(buf) >>> 0

/** name length (1) | name | type (7 = string) | value length (2) | value */
function stringHeader(name, value) {
  const n = Buffer.from(name, 'utf8')
  const v = Buffer.from(value, 'utf8')
  const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length)
  let o = 0
  out.writeUInt8(n.length, o++)
  n.copy(out, o)
  o += n.length
  out.writeUInt8(7, o++)
  out.writeUInt16BE(v.length, o)
  o += 2
  v.copy(out, o)
  return out
}

export function encodeAudioEvent(pcm) {
  const headers = Buffer.concat([
    stringHeader(':message-type', 'event'),
    stringHeader(':event-type', 'AudioEvent'),
    stringHeader(':content-type', 'application/octet-stream'),
  ])

  const total = 12 + headers.length + pcm.length + 4
  const frame = Buffer.alloc(total)
  frame.writeUInt32BE(total, 0)
  frame.writeUInt32BE(headers.length, 4)
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8)
  headers.copy(frame, 12)
  pcm.copy(frame, 12 + headers.length)
  frame.writeUInt32BE(crc32(frame.subarray(0, total - 4)), total - 4)
  return frame
}

export const encodeEndOfStream = () => encodeAudioEvent(Buffer.alloc(0))

export function decodeFrame(data) {
  if (data.length < 16) return null
  const total = data.readUInt32BE(0)
  const headersLength = data.readUInt32BE(4)
  if (total > data.length) return null

  const headers = {}
  let o = 12
  const headersEnd = 12 + headersLength
  while (o < headersEnd) {
    const nameLength = data.readUInt8(o++)
    const name = data.subarray(o, o + nameLength).toString('utf8')
    o += nameLength
    if (data.readUInt8(o++) !== 7) break // only string headers appear here
    const valueLength = data.readUInt16BE(o)
    o += 2
    headers[name] = data.subarray(o, o + valueLength).toString('utf8')
    o += valueLength
  }

  return { headers, payload: data.subarray(headersEnd, total - 4).toString('utf8') }
}
