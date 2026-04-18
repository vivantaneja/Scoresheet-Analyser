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

1. **`GROQ_API_KEY`**: vision extraction API key (required for uploads to work).
2. Optional **`GROQ_MODEL`**: defaults are in `.env.example`.
3. Optional **`CHAT_VISION_MAX_TOKENS`**: default `8192`. Large scoresheets need headroom for valid JSON with `json_object` mode; if the API rejects max output, try `4096`.
4. Optional **`SESSION_SECRET`**: 32+ random characters. Required when `NODE_ENV=production`; omitted locally uses a dev-only default.
5. Optional **`UPSTASH_REDIS_REST_URL`** / **`UPSTASH_REDIS_REST_TOKEN`**: omit locally (uses **`.user-data/`**); required on Vercel for persistence.

## 3. Run

```bash
npm start
```

Open the app; the terminal should show that the extraction API key is set.

## Images only

Use **JPEG, PNG, GIF, or WebP**. Size limits: **`UPLOAD_MAX_FILE_MB`** (multipart; default **20** locally, **~4** on Vercel because the **whole request body is ~4.5MB max** on Vercel) and **`VISION_MAX_DATA_URL_MB`** (base64 sent to the vision API; default **3.5**). Base64 is ~33% larger than the raw file; for bigger images use self-hosting/Docker or a direct-to-storage upload flow.

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
