# OKAD Muse Worker

Cloudflare Worker that proxies OKAD website requests to OpenRouter's Meta Muse Image API.

## What it does

- Receives `{ prompt, userId }` from the OKAD website
- Calls OpenRouter's `/v1/images` endpoint with `meta/muse-image` model
- Returns `{ image: "data:image/png;base64,..." }` to the frontend
- Built-in CORS + per-IP rate limiting (10 req/min)

## Cost

- **Worker**: Free (100,000 requests/day)
- **OpenRouter**: $0.01 per image
- **Total**: ~$0.01 per generation

## Setup (5 min)

See [README.md](./README.md) for the full step-by-step guide.

TL;DR:
1. Get OpenRouter API key: https://openrouter.ai/keys
2. Create Cloudflare Worker: https://dash.cloudflare.com → Workers & Pages
3. Paste `worker.js` into the Worker editor
4. Add secret variable `OPENROUTER_API_KEY = sk-or-v1-...`
5. Save and deploy
6. Copy Worker URL into OKAD admin → AI tab

## API

### POST `/`

Request:
```json
{
  "prompt": "A red apple on white background, studio lighting",
  "userId": "+8613800000000"
}
```

Response:
```json
{
  "image": "data:image/png;base64,iVBORw...",
  "model": "meta/muse-image",
  "provider": "openrouter",
  "elapsed_ms": 21340,
  "user": "+8613800000000",
  "prompt_chars": 51
}
```

### GET `/`

Health check. Returns:
```json
{"ok": true, "service": "OKAD Muse Proxy", ...}
```

## Files

- `worker.js` — Main Worker code
- `README.md` — Setup guide (Chinese + English)
- `package.json` — npm metadata (for wrangler)
- `wrangler.toml.example` — Example wrangler config (rename to `wrangler.toml` if using wrangler CLI)