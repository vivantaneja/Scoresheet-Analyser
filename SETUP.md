# Setup checklist

## 1. Install

```bash
npm install
```

**Node.js 18+** required.

## 2. Environment

```bash
cp .env.example .env
```

In `.env`:

1. **`GROQ_API_KEY`**: from [Groq Console → API Keys](https://console.groq.com/keys).
2. Optional **`GROQ_MODEL`**: default `meta-llama/llama-4-scout-17b-16e-instruct` ([vision docs](https://console.groq.com/docs/vision)).
3. Optional **`CHAT_VISION_MAX_TOKENS`**: default `4096` (capped at `8192`; higher defaults can cause Groq 400 on vision + long prompts).
4. Optional **`SESSION_SECRET`**: 32+ random characters. Required when `NODE_ENV=production`; omitted locally uses a dev-only default.
5. Optional **`UPSTASH_REDIS_REST_URL`** / **`UPSTASH_REDIS_REST_TOKEN`**: omit locally (uses **`.user-data/`**); required on Vercel for persistence.

## 3. Run

```bash
npm start
```

Open the app; the terminal should show `GROQ_API_KEY: set`.

## Images only

Use **JPEG, PNG, GIF, or WebP**. Keep files small enough for Groq’s payload limit (~4MB as a data URL; ~2.5MB file size is a safe target).

## Docker

Node-only image: see `Dockerfile`. Build: `docker build -t scoresheet-analyser .`, then run with `-e GROQ_API_KEY=...`.

## Vercel

Set **`GROQ_API_KEY`**, **`SESSION_SECRET`**, **`UPSTASH_REDIS_REST_URL`**, and **`UPSTASH_REDIS_REST_TOKEN`** in the project env; redeploy after changes.

Create a Redis database in the [Upstash console](https://console.upstash.com/), copy the REST URL and token into Vercel.

Optional **upload limits** (same Redis): defaults are **20 uploads per hour** per IP+session (`UPLOAD_RATELIMIT_MAX`, `UPLOAD_RATELIMIT_WINDOW`).

Optional **Cloudflare Turnstile** (bot friction): create a widget in [Cloudflare Turnstile](https://dash.cloudflare.com/), set **`TURNSTILE_SITE_KEY`** and **`TURNSTILE_SECRET_KEY`** on the host (both required for verification to succeed).

## Compare two extraction JSON files

```bash
npm run compare:json -- path/to/a.json path/to/b.json
```
