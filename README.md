# ESSE — Elite Songs Suggestion Engine

A focused Cloudflare Workers API that suggests the best next songs after a seed track. Gemini is primary by default, with Elite LLMs as fallback; keyless YouTube Innertube search is a mandatory verification gate. No UI, player, accounts, or database.

## Setup

Use Node.js 22.12+ and npm.

```sh
npm install
cp .dev.vars.example .dev.vars
# Replace the credential placeholders in .dev.vars (PowerShell: Copy-Item .dev.vars.example .dev.vars).
npm run dev
```

| Variable | Configuration |
| --- | --- |
| `ELITE_API_KEY` | Elite LLMs API secret |
| `ELITE_BASE_URL` | Elite OpenAI-compatible API base URL |
| `ELITE_MODEL` | Primary recommendation model |
| `ELITE_TIMEOUT_MS` | One bounded Elite attempt; default 6000 ms |
| `GEMINI_API_KEY` | Gemini Developer API secret |
| `GEMINI_MODEL` | Configured once in `wrangler.jsonc`; may be overridden locally |
| `LLM_PROVIDER_ORDER` | Ordered providers (`gemini,elite` by default; `elite,gemini` is supported) |
| `ESSE_API_KEYS` | Required comma-separated client bearer keys; use strong random values and rotate by temporarily listing old and new keys |

Never commit credentials. Keep both LLM keys in local/Worker secret configuration. The configured provider order is tried until one returns a valid canonical result; provider errors, invalid output and cooldown move to the next available provider. The final-result cache is provider-independent. YouTube search needs no API key, cookies, or login. The health endpoint reports process liveness, not provider readiness.

## API

The production API contract, request/error schemas, native-fetch examples, and TypeScript client are documented in the [API reference](API.md). The machine-readable public schema is [openapi.yaml](openapi.yaml).

```sh
curl http://localhost:8787/health
curl http://localhost:8787/v1/recommend \
  -H 'Authorization: Bearer <your-ESSE-API-KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"song":"Ek Vaari Aa","artist":"Arijit Singh","limit":5}'
```

Illustrative response only; recommendations are generated, never hardcoded:

```json
{
  "seed": { "title": "Ek Vaari Aa", "artist": "Arijit Singh" },
  "recommendations": [{ "title": "Hawayein", "artist": "Arijit Singh" }],
  "count": 1
}
```

`artist` is optional. `limit` defaults to 5 and must be an integer from 1–5. Text fields allow 1–200 characters; body size is capped at 4096 bytes. A successful empty/short result means the bounded candidate pool contained insufficient safe matches. Verification outages fail the request, including when some earlier candidates passed.

Errors include a safe code, message, and request ID; error responses are not cacheable. Codes include `unauthorized` (401), `invalid_request` (400/415), `rate_limited` (429), `upstream_unavailable` (502/503/504), and `internal_error`. Raw provider errors and credentials are never returned or logged. `/health` is public. No CORS policy is enabled; browser clients need a deliberate allowed-origin policy before use.

## Deployment security

Production is deployed at `https://esse.skybotsdeveloper.workers.dev`. Configure required `ESSE_API_KEYS` and `GEMINI_API_KEY`, plus optional `ELITE_API_KEY`, as Worker secrets rather than Wrangler `vars`. Keep client keys server-side and out of GitHub; a comma-separated client-key list allows rotation. The Worker applies per-client limits of 60 requests/minute and 10 uncached generations/minute. Rate limits are regional, eventually consistent abuse controls, not exact accounting.

### Staging preflight

Staging is deployed as the separate `esse-staging` Worker at `https://esse-staging.skybotsdeveloper.workers.dev`, with `LLM_PROVIDER_ORDER=gemini,elite` and isolated rate-limit bindings. Staging requires only `ESSE_API_KEYS` and `GEMINI_API_KEY`; Elite remains optional. Its high-entropy namespace IDs differ from the production IDs in this repository; account-wide uniqueness was not independently verified, so treat it as best-effort.

The initial staging flow used an ignored `.secrets.staging` file with `npm run deploy:staging -- --secrets-file .secrets.staging`, then checked health, missing/invalid auth, one authenticated recommendation, its identical cache repeat, and Worker logs. The secret file remains local and must not be committed. Wrangler's `secret put` deploys a Worker version, so use `--secrets-file` for first-deploy secret provisioning.

## Architecture

- `src/index.ts`: native Request/Response routing and safe error boundary.
- `src/validation.ts`: runtime input validation and bounded body reading.
- `src/service.ts`: ranked candidate traversal, identity/video deduplication, and count limits. `src/identity.ts` compares base songs and normalized artists before verification and again against verified upload metadata.
- `src/providers/elite.ts`: one bounded native-fetch chat completion, strict shared recommendation validation, and isolate-local cooldown. Mistral Small 4 uses strictly validated tool arguments; other Elite models retain the text path.
- `src/providers/order.ts`: validated, configurable provider order (`gemini,elite` by default) and safe fallback diagnostics.
- `src/providers/gemini.ts`: Gemini fallback generation, maximum 20 ranked candidates, strict runtime schema validation. Elite and Gemini share the same recommendation instruction and validator.
- `src/providers/youtube.ts`: at most one search per candidate, scores up to 20 video results. Requires title/artist evidence plus an artist/Topic/VEVO channel or a recognized label. Rejects unrequested versions; never blindly trusts result #1.
- `src/providers/innertube.ts`: isolated native-fetch POST to YouTube's Innertube search endpoint; centralized WEB client context, video filter, timeout and parsing bounds. Parses primary section-list/rich-grid `videoRenderer` results, ignores ads/related shelves and never follows continuations. Unsupported shapes or missing metadata fail with 502; only a recognized explicit no-results response counts as an empty search. No audio/video streams are requested.
- `src/cache.ts`: optional, best-effort Cloudflare Cache API storage of positive verifications for 24 hours, with hashed keys. Errors and negative matches are not cached.

No runtime npm dependencies. Providers implement small replaceable interfaces. Elite gets one 6-second attempt by default; Gemini retains its bounded failover policy; each YouTube call gets 5 seconds, without retries. Sequential traversal stops as soon as the requested count is reached. At worst there are 20 YouTube searches and approximately 120 seconds of upstream wait. Upload marketing text is not used as the public song title; verified candidate title/artist are retained.

## Verify and deploy

```sh
npm run typecheck
npm test
npm run build
npm audit
# With npm run dev running in another terminal:
npm run smoke
npx wrangler login
npx wrangler secret put ELITE_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ESSE_API_KEYS
npm run deploy
```

`build` bundles and validates Wrangler configuration with `deploy --dry-run`; it does not deploy. Tests mock providers and fetch, including minimized Innertube JSON fixtures; no live API calls are made. Production secrets are separate from `.dev.vars`.

## Phase 1 limitations

Matching is conservative metadata verification, not audio fingerprinting or proof of channel ownership. Channel names can be impersonated; the initial label list is deliberately small. Transliteration, collaborator credits and regional metadata may yield false negatives. Base-song identity excludes common upload/version decorations while preserving same-title songs by clearly different artists; missing artists are handled conservatively. Unrecognized aliases still need external metadata. Gemini quality and seed disambiguation need real listening evaluation; the seed is not separately resolved through a music catalog.

## Human evaluation

`npm run eval` runs two curated seeds through the real providers and recommendation service. It defaults to direct Gemini evaluation for baseline continuity; `--provider elite` evaluates Elite directly and never calls Gemini. Credentials come from the environment or `.dev.vars`; selected models come from environment/local configuration or Wrangler. Node 22.12+ is required.

```sh
npm run eval -- --max-seeds 2
npm run eval -- --seed hindi-romantic --limit 5 --json
npm run eval -- --seed hindi-romantic --provider elite --model gpt-5.6-luna --json
npm run eval -- --seed hindi-romantic --provider gemini --json
npm run eval -- --dry --max-seeds 2
```

The fixed benchmark is listed in `scripts/eval-seeds.json`; use `--seed`, `--category`, or `--max-seeds` to select a subset. Reports show final ranking, candidate/rejection counts and reasons, seed exclusions, cache hits/misses, selected provider/model latency, YouTube checks and total latency. `--json` writes to ignored `eval-results/`. No prompts, reasoning, or keys are recorded. Mock mode makes no network calls. The CLI uses the same cache wrapper with a run-scoped positive cache (24-hour TTL), shared across seeds; production continues using the Workers Cache API. Runs stop on upstream failure. Diagnostics are never added to the public API response.

Innertube is undocumented and may change client requirements, return new renderers, throttle or block serverless IPs. Unsupported video shapes (including lockup view models) fail closed until covered by fixtures and an explicit parser update. Search visibility does not guarantee playback in every region. A request may issue up to 20 searches; no official YouTube Data API quota/key is used. Cache entries are local to a Cloudflare data center, may be evicted, and can briefly retain deleted videos. Application bearer authentication and per-client Cloudflare rate limits are enabled; the native limiter is regional and eventually consistent, not exact accounting. Gemini calls and deployment require your credentials.

References: [Gemini structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), [yt-search-python search concepts](https://github.com/BillaSpace/yt-search-python/blob/legacy/youtubesearchpython/core/search.py). The TypeScript adapter implements only search; no Python code or library runs in ESSE.
