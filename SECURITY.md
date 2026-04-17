# Security

## API key (Groq)

- **Never commit `.env`.** It holds `GROQ_API_KEY`. The repo ignores `.env` via `.gitignore`.
- Use **`.env.example`** as a template: copy to `.env` and add your key from [Groq Console](https://console.groq.com/keys).
- On Vercel, Railway, etc., set `GROQ_API_KEY` in the host’s environment; do not upload `.env`.

## Git hook (recommended)

After cloning or `git init`, install the pre-commit hook so `.env` cannot be committed by mistake:

```bash
sh scripts/install-git-hooks.sh
```

## If `.env` was ever committed

1. Remove it: `git rm --cached .env` and commit.
2. Rotate the key in the Groq console and put the new key only in `.env` (never commit it).
