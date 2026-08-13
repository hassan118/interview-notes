#!/usr/bin/env node
/**
 * Publish a text transcript.
 *
 *   GITHUB_TOKEN=... node tools/publish-text.mjs interview.txt ["Optional title"]
 *
 * One line of the file per spoken line. Nova Lite writes the summary.
 */
import fs from 'node:fs'
import { publish, summarize } from './lib.mjs'

const [file, title] = process.argv.slice(2)
if (!file) {
  console.error('usage: publish-text.mjs <file.txt> [title]')
  process.exit(1)
}

const lines = fs
  .readFileSync(file, 'utf8')
  .split(/\r?\n+/)
  .map(l => l.trim())
  .filter(Boolean)

if (!lines.length) {
  console.error('that file has no text in it')
  process.exit(1)
}

const summary = await summarize(lines)
const published = await publish({
  transcript: lines.map(text => ({ text })),
  summary,
  title,
  date: new Date(fs.statSync(file).mtime).toISOString(),
})

console.log(published.title)
console.log(published.url)
