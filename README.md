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

## Deployment (Vercel, public multi-user)

1. Connect the repo and deploy.
2. Set environment variables:
   - **`GROQ_API_KEY`** (and optional **`GROQ_MODEL`**).
   - **`SESSION_SECRET`**: a long random string (32+ characters) used to sign the httpOnly session cookie so each browser gets a stable anonymous user id.
   - **`UPSTASH_REDIS_REST_URL`** and **`UPSTASH_REDIS_REST_TOKEN`**: [Upstash](https://upstash.com/) Redis (REST) so each user’s scoresheet JSON persists across serverless invocations. Without these on Vercel, `/api` returns 503. The same Redis powers **distributed upload rate limits** (optional tuning: `UPLOAD_RATELIMIT_MAX`, `UPLOAD_RATELIMIT_WINDOW`).
   - Optional **`TURNSTILE_SITE_KEY`** and **`TURNSTILE_SECRET_KEY`**: [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) — human verification before upload (recommended for a public site).
3. `vercel.json` bundles `server.js` plus `*.html`, `assets/**`, `schema.json`, `extraction-prompt.txt`.

Locally, Redis is optional: data is stored under **`.user-data/<session-id>.json`** (gitignored).

## Limitations

- **Images only** for extraction (no PDF/HEIC in the Groq path). Export or scan as PNG/JPEG.
- **~4MB** effective limit on the base64 payload; use a reasonably sized photo.
- **Quality** depends on scan quality, handwriting, and layout; verify against the paper sheet.
- **Names** from the model may be misread; correct them in the review screen before relying on them.

## Data on disk

- **Per-user match JSON**: one object per anonymous session — Upstash when configured, else **`.user-data/`** on the machine running Node.
- **`uploads/`**: temporary uploaded files (removed after extraction).
- **`last-extraction.json`**: written only if **`EXTRACTION_DEBUG=1`** and not on Vercel (debug).

Uploads are **rate-limited** per IP (Express) and, when Redis is configured, by **Upstash Ratelimit** across instances. Optional **Cloudflare Turnstile** can be enabled with `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`. Groq’s [terms](https://console.groq.com/docs/legal) apply to API usage.

## Optional: compare two JSON files

```bash
npm run compare:json -- eval/baseline.json eval/candidate.json
```

(Requires `python3` on PATH; stdlib only.)
