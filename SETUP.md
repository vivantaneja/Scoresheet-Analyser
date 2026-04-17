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

Set `GROQ_API_KEY` in the project env; redeploy after changes.

## Compare two extraction JSON files

```bash
npm run compare:json -- path/to/a.json path/to/b.json
```
