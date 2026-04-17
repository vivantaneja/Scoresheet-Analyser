# Scoresheet Analyser

Web app for uploading basketball scoresheet **images** (JPEG/PNG/GIF/WebP), extracting structured match data with **Groq** (vision + JSON), and reviewing or editing the result in the browser.

## Requirements

- [Node.js](https://nodejs.org/) 18+ (uses built-in `fetch`)
- A free [Groq](https://console.groq.com/keys) API key

## Local setup

See **[SETUP.md](SETUP.md)** for a short checklist.

1. `npm install`
2. `cp .env.example .env` and set `GROQ_API_KEY` (optional: `GROQ_MODEL`, `CHAT_VISION_MAX_TOKENS`).
3. `npm start` → [http://localhost:3000](http://localhost:3000); review UI at `/review.html`.

(Optional) Install the Git pre-commit hook: `sh scripts/install-git-hooks.sh` (see [SECURITY.md](SECURITY.md)).

## Deployment (Vercel)

1. Connect the repo and deploy.
2. Set **`GROQ_API_KEY`** (and optional `GROQ_MODEL`) in the project environment variables.
3. `vercel.json` bundles `server.js` plus `*.html`, `assets/**`, `schema.json`, `extraction-prompt.txt`.

## Limitations

- **Images only** for extraction (no PDF/HEIC in the Groq path). Export or scan as PNG/JPEG.
- **~4MB** effective limit on the base64 payload; use a reasonably sized photo.
- **Quality** depends on scan quality, handwriting, and layout; verify against the paper sheet.
- **Names** from the model may be misread; correct them in the review screen before relying on them.

## Data on disk

- **`data.json`**: last extracted match JSON.
- **`uploads/`**: uploaded files (cleared after successful extraction).
- **`last-extraction.json`**: last parsed API JSON (debug).

Groq’s [terms](https://console.groq.com/docs/legal) apply to API usage.

## Optional: compare two JSON files

```bash
npm run compare:json -- eval/baseline.json eval/candidate.json
```

(Requires `python3` on PATH; stdlib only.)
