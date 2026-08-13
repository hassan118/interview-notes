# Interview notes

Transcripts and summaries, published from the phone app or from the command line.
Site: https://hassan118.github.io/interview-notes/ (asks for the passphrase once).

Conversation files are encrypted before they are committed — PBKDF2-SHA256
(60,000 rounds) and AES-256-CBC — so the repo can stay public. Only the listing
(titles, dates, line counts) is readable.

## Layout

- `docs/index.html` — the viewer, served by GitHub Pages from `/docs`
- `docs/data/index.json` — the listing the viewer reads
- `docs/data/conversation-N.json` — one encrypted conversation
- `docs/data/check.json` — encrypted `{"ok":true}`, used to test the passphrase
- `tools/` — publish from a machine instead of the phone

## Publishing from a machine

Needs Node 18+ and a GitHub token with **Contents: read and write** on this repo.
AWS needs no keys: credentials come from the same public Cognito pool the app uses.

```sh
export GITHUB_TOKEN=github_pat_...

# a text transcript, one spoken line per line of the file
node tools/publish-text.mjs interview.txt "Kickoff call"

# an audio file — Amazon Transcribe writes the text (ffmpeg converts the audio)
node tools/publish-audio.mjs interview.m4a "Site visit"
```

Both print the title and the link. Optional: `NOTES_PASSPHRASE`, `GITHUB_REPO`,
`GITHUB_BRANCH`, and `LANGUAGE` (default `en-US`).

## Stack

| Piece | What |
|---|---|
| App | React Native, Android — no backend |
| Credentials | Amazon Cognito identity pool, temporary |
| Speech to text | Amazon Transcribe streaming |
| Cleanup + summary | Amazon Nova Lite on Bedrock (any Bedrock model works) |
| Storage | this repo, committed directly |
| Site | static HTML on GitHub Pages |
