# Publishing to this site

The site is https://hassan118.github.io/interview-notes/ — a passphrase-locked list of
conversations. Each conversation is one encrypted JSON file in `docs/data/`, listed in
`docs/data/index.json`.

To add a conversation, run one of these from the repo root. Both print the title and the
live URL when they finish.

    GITHUB_TOKEN=<token> node tools/publish-text.mjs  transcript.txt  "Optional title"
    GITHUB_TOKEN=<token> node tools/publish-audio.mjs recording.m4a   "Optional title"

- **Text**: one spoken line per line of the file.
- **Audio**: any format if `ffmpeg` is on PATH; otherwise a 16 kHz mono 16-bit WAV.

Both scripts summarise with Amazon Nova Lite, encrypt with the site passphrase, and commit
straight to `main`. The page rebuilds about a minute later.

## What you need

| | |
|---|---|
| `GITHUB_TOKEN` | required — fine-grained, Contents: read and write on this repo |
| `NOTES_PASSPHRASE` | optional — defaults to the site's passphrase, `skippyta` |
| AWS keys | none; credentials come from a public Cognito identity pool |
| Node | 20+ (uses the built-in `fetch` and `WebSocket`) |

## Layout

| Path | What it is |
|---|---|
| `docs/index.html` | the whole site: passphrase gate, recorder, viewer |
| `docs/data/index.json` | plaintext listing (id, title, date, line count) |
| `docs/data/conversation-N.json` | the encrypted conversation |
| `docs/data/check.json` | encrypted `{ok:true}`, used to test the passphrase |
| `tools/lib.mjs` | AWS credentials, SigV4, Nova Lite, encryption, the GitHub commit |
| `apk/interview.apk` | the standalone Android app |
