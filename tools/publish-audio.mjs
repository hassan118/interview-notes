#!/usr/bin/env node
/**
 * Publish an audio file: transcribe it with Amazon Transcribe, summarise with
 * Nova Lite, encrypt, commit.
 *
 *   GITHUB_TOKEN=... node tools/publish-audio.mjs interview.m4a ["Optional title"]
 *
 * Needs ffmpeg on PATH to turn anything into 16 kHz mono PCM. A file that is
 * already 16 kHz mono 16-bit WAV works without it.
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { AWS_REGION, getCredentials, presignWebSocket, publish, summarize } from './lib.mjs'
import { decodeFrame, encodeAudioEvent, encodeEndOfStream } from './eventstream.mjs'

const SAMPLE_RATE = 16000
const CHUNK = 6400 // 200 ms of audio
const [file, title] = process.argv.slice(2)
const language = process.env.LANGUAGE || 'en-US'

if (!file) {
  console.error('usage: publish-audio.mjs <file> [title]')
  process.exit(1)
}

/** Raw little-endian 16-bit mono PCM at 16 kHz, however we can get it. */
function readPcm(path) {
  const ffmpeg = spawnSync('ffmpeg', [
    '-v', 'error',
    '-i', path,
    '-f', 's16le',
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    'pipe:1',
  ], { maxBuffer: 1 << 30 })

  if (!ffmpeg.error && ffmpeg.status === 0) return ffmpeg.stdout

  const raw = fs.readFileSync(path)
  const isWav = raw.subarray(0, 4).toString() === 'RIFF'
  if (!isWav) {
    console.error('Install ffmpeg, or hand me a 16 kHz mono 16-bit WAV.')
    process.exit(1)
  }

  const channels = raw.readUInt16LE(22)
  const rate = raw.readUInt32LE(24)
  const bits = raw.readUInt16LE(34)
  if (channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
    console.error(`That WAV is ${rate} Hz, ${channels} channel(s), ${bits}-bit. Install ffmpeg, or convert it to 16 kHz mono 16-bit.`)
    process.exit(1)
  }

  // skip to the data chunk
  let o = 12
  while (o + 8 <= raw.length) {
    const id = raw.subarray(o, o + 4).toString()
    const size = raw.readUInt32LE(o + 4)
    if (id === 'data') return raw.subarray(o + 8, o + 8 + size)
    o += 8 + size
  }
  console.error('That WAV has no audio in it.')
  process.exit(1)
}

const pcm = readPcm(file)
const seconds = Math.round(pcm.length / 2 / SAMPLE_RATE)
console.error(`transcribing ${seconds}s of audio…`)

const creds = await getCredentials()
const url = presignWebSocket({
  host: `transcribestreaming.${AWS_REGION}.amazonaws.com:8443`,
  path: '/stream-transcription-websocket',
  service: 'transcribe',
  creds,
  query: {
    'language-code': language,
    'media-encoding': 'pcm',
    'sample-rate': String(SAMPLE_RATE),
  },
})

const lines = await new Promise((resolve, reject) => {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const collected = []

  ws.onopen = async () => {
    // Transcribe wants audio at roughly the speed it was spoken
    for (let o = 0; o < pcm.length; o += CHUNK) {
      ws.send(encodeAudioEvent(pcm.subarray(o, o + CHUNK)))
      await new Promise(r => setTimeout(r, 100))
    }
    ws.send(encodeEndOfStream())
  }

  ws.onmessage = event => {
    const frame = decodeFrame(Buffer.from(new Uint8Array(event.data)))
    if (!frame) return
    if (frame.headers[':message-type'] === 'exception') {
      reject(new Error(`${frame.headers[':exception-type']}: ${frame.payload}`))
      return
    }
    for (const result of JSON.parse(frame.payload)?.Transcript?.Results ?? []) {
      const text = result.Alternatives?.[0]?.Transcript
      if (text && !result.IsPartial) collected.push(text)
    }
  }

  ws.onerror = () => reject(new Error('Transcribe connection failed'))
  ws.onclose = () => resolve(collected)
})

if (!lines.length) {
  console.error('nothing was said in that file')
  process.exit(1)
}

const summary = await summarize(lines, language)
const published = await publish({
  transcript: lines.map(text => ({ text })),
  summary,
  language,
  title,
  date: new Date(fs.statSync(file).mtime).toISOString(),
})

console.log(published.title)
console.log(published.url)
