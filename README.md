# Avinash Dual Lossless — BitChord Addon

Node.js 20+ / Express addon with two sources:
- Internet Archive audio catalogue (prefers FLAC when an item contains it).
- A local audio folder (`music/`) containing your own FLAC and other audio files.

## Project files

- `server.js` — search, stream and signed media endpoints.
- `manifest.json` — BitChord addon manifest with `bitchordAuth: true`.
- `bitchord-addon-auth.mjs` — official BitChord verifier, copied unchanged.
- `.env.example` — required deployment configuration.
- `render.yaml` — Render deployment blueprint.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Set `BITCHORD_HOSTS` to the hostname you will use. For local-only development, set it to `localhost`.
4. Add a long random `MEDIA_SECRET` to `.env` (at least 32 random characters).
5. Run:

```bash
npm install
npm run check
npm start
```

The public manifest is at `http://localhost:3000/manifest.json`.
Health check: `http://localhost:3000/health`.

## API

- `GET /manifest.json` — public manifest.
- `GET /search?q=artist%20or%20track` — returns local and Internet Archive results.
- `GET /stream/{id}` — returns a BitChord-compatible stream object with an absolute, 30-minute signed media URL. Use the opaque `id` returned by `/search`.
- `GET /media/:id?exp=...&sig=...` — signed audio delivery; intentionally does not require BitChord auth headers.
- `GET /health` — health check.

## Deploy on Render

1. Push this folder to a GitHub repository named `avinash-dual-lossless`.
2. In Render, create a new **Blueprint** and select that repository.
3. In Render environment settings, set:
   - `BITCHORD_HOSTS` = the exact public hostname Render assigns, without `https://`, port or path.
   - `PUBLIC_BASE_URL` = the full public origin, including `https://`.
   - `MEDIA_SECRET` = a long random secret.
   - `MEDIA_SECRET` = a long random secret.
   - `BITCHORD_AUTH_MODE` = `log` initially.
4. Deploy. Copy the resulting public URL and open `/manifest.json`.
5. Add the manifest URL in BitChord: **Settings → Sources → Add an addon**.
6. Test search and playback. Check server logs for `invalid_proof`. If it appears, correct `BITCHORD_HOSTS`.
7. After confirming official BitChord requests authenticate successfully, set `BITCHORD_AUTH_MODE=enforce` and redeploy.

## Important

- The exact public hostname is not known yet. Do not leave the example value in production. The verifier defaults to `localhost` only for local development; set `BITCHORD_HOSTS` to your actual public hostname before deploying/enforcing auth.
- `log` mode verifies and logs auth failures but still serves API requests. It is a rollout mode, not protection. Use `enforce` after validation.
- The official BitChord Android app is required for authenticated requests. The auth brief says desktop/web clients cannot prove they are genuine.
- Internet Archive items have different rights and formats. Only stream material you are permitted to access and use.
- Local files placed on Render's ephemeral filesystem may not persist across redeploys. For a persistent personal library, use a persistent disk or external object storage.
- Search returns `{ "tracks": [...] }`; stream returns the documented BitChord rendition fields and an absolute signed URL. Internet Archive records vary: the addon selects a FLAC file when the item exposes one, otherwise it selects another playable audio file.
