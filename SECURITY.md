# Security

## API key (Groq)

- **Never commit `.env`.** It holds `GROQ_API_KEY`. The repo ignores `.env` via `.gitignore`.
- Use **`.env.example`** as a template: copy to `.env` and add your key from [Groq Console](https://console.groq.com/keys).
- On Vercel, Railway, etc., set `GROQ_API_KEY` in the host’s environment; do not upload `.env`.

## Public multi-user mode

- **`SESSION_SECRET`**: required in production (`NODE_ENV=production` or `VERCEL=1`). Used to sign the httpOnly **`sa_session`** cookie so each browser gets a stable anonymous user id. Rotate it to invalidate all sessions. Generate e.g. `openssl rand -hex 32`.
- **`UPSTASH_REDIS_REST_*`**: on Vercel, scoresheet JSON is stored in Redis keyed by that user id. Protect the Upstash token like any database credential.
- **Local**: without Redis, JSON lives under **`.user-data/`** (gitignored). Do not serve that directory from another web root.

## Rate limits

- **`POST /api/upload`**: Express `express-rate-limit` per IP, plus **Upstash Ratelimit** (when Redis is configured) so limits are shared across serverless instances. Env: `UPLOAD_RATELIMIT_MAX`, `UPLOAD_RATELIMIT_WINDOW`.
- **`GET`/`PUT /api/data`**: softer per-IP limits.

## Cloudflare Turnstile

If **`TURNSTILE_SECRET_KEY`** is set, uploads must include a valid **`cf-turnstile-response`** token. Set **`TURNSTILE_SITE_KEY`** as well so `/api/config` exposes it to the homepage widget. Secret stays server-side only.

## Git hook (recommended)

After cloning or `git init`, install the pre-commit hook so `.env` cannot be committed by mistake:

```bash
sh scripts/install-git-hooks.sh
```

## If `.env` was ever committed

1. Remove it: `git rm --cached .env` and commit.
2. Rotate the key in the Groq console and put the new key only in `.env` (never commit it).
