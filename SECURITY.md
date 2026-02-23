# Security

## API key (Gemini)

- **Never commit `.env`.** It holds `GEMINI_API_KEY`. The repo ignores `.env` via `.gitignore`.
- Use **`.env.example`** as a template: copy to `.env` and add your key. Get a key at [Google AI Studio](https://aistudio.google.com/apikey).
- If you deploy (e.g. Vercel, Railway), set `GEMINI_API_KEY` in the host’s environment variables; do not upload `.env`.

## Git hook (recommended)

After cloning or `git init`, install the pre-commit hook so `.env` cannot be committed even by mistake:

```bash
sh scripts/install-git-hooks.sh
```

## If `.env` was ever committed

1. Remove it: `git rm --cached .env` and commit.
2. Rotate the key: revoke the old key in Google AI Studio and create a new one.
3. Put the new key only in `.env` (never commit it).
