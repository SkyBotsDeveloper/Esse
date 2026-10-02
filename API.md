# ESSE API

Production base URL: `https://esse.skybotsdeveloper.workers.dev`

## Health

`GET /health` is public. A healthy Worker returns HTTP 200:

```json
{"status":"ok"}
```

This reports Worker liveness, not provider readiness.

## Recommend

`POST /v1/recommend` requires `Authorization: Bearer <ESSE_API_KEY>` and `Content-Type: application/json`.

Request fields:

| Field | Type | Required | Details |
| --- | --- | --- | --- |
| `song` | string | yes | Song title; 1–200 characters after trimming, without control characters. |
| `artist` | string | no | Artist name; if supplied, 1–200 characters after trimming, without control characters. |
| `limit` | integer | no | Number requested, 1–5. Defaults to 5. |

The JSON body is limited to 4096 bytes. A successful response contains only the seed, verified recommendations, and count. It can contain fewer than requested (including zero) when the bounded candidate set has too few safe matches.

```json
{
  "seed": { "title": "Perfect", "artist": "Ed Sheeran" },
  "recommendations": [{ "title": "All of Me", "artist": "John Legend" }],
  "count": 1
}
```

`seed.artist` is omitted when no artist was supplied. Each recommendation contains `title` and `artist`; `count` equals the array length and never exceeds `limit` or 5.

### Errors

Error responses have this shape and include a request ID:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Unauthorized.",
    "requestId": "request-id"
  }
}
```

| HTTP | Public code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid JSON, fields, limit, or body size. |
| 401 | `unauthorized` | Missing or invalid bearer key. |
| 404 | `not_found` | Unknown route. |
| 405 | `method_not_allowed` | Wrong method for a known route. |
| 415 | `invalid_request` | Request must use JSON content type. |
| 429 | `rate_limited` | Per-client request or generation limit reached. |
| 502, 503, 504 | `upstream_unavailable` | Recommendation provider or verification service unavailable. |
| 500, 503 | `internal_error` | Unexpected or service-configuration failure. |

Every response includes `X-Request-Id`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Public errors do not include provider details.

## cURL

```sh
curl --fail-with-body 'https://esse.skybotsdeveloper.workers.dev/v1/recommend' \
  -H 'Authorization: Bearer YOUR_ESSE_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"song":"Perfect","artist":"Ed Sheeran","limit":5}'
```

## JavaScript with native fetch

Run this in a server-side Node.js process and set `ESSE_API_KEY` in its environment:

```js
const apiKey = process.env.ESSE_API_KEY;
if (!apiKey) throw new Error('Set ESSE_API_KEY in the server environment.');

const response = await fetch('https://esse.skybotsdeveloper.workers.dev/v1/recommend', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ song: 'Perfect', artist: 'Ed Sheeran', limit: 5 }),
});
const payload = await response.json().catch(() => null);
if (!response.ok) {
  const code = payload?.error?.code ?? 'api_error';
  throw new Error(`ESSE returned HTTP ${response.status} (${code}).`);
}
if (!payload) throw new Error('ESSE returned invalid JSON.');

for (const recommendation of payload.recommendations) {
  console.log(`${recommendation.title} — ${recommendation.artist}`);
}
```

## Python with the standard library

Set `ESSE_API_KEY` in the server environment. This example uses only `urllib` and `json` from Python's standard library.

```python
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen

api_key = os.environ["ESSE_API_KEY"]
request = Request(
    "https://esse.skybotsdeveloper.workers.dev/v1/recommend",
    data=json.dumps({"song": "Perfect", "artist": "Ed Sheeran", "limit": 5}).encode(),
    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    method="POST",
)

try:
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
except HTTPError as error:
    failure = json.loads(error.read())
    raise RuntimeError(f"ESSE returned HTTP {error.code} ({failure['error']['code']}).") from None

for song in result["recommendations"]:
    print(f"{song['title']} — {song['artist']}")
```

## TypeScript client

The repository includes a dependency-free client at [`client/index.ts`](client/index.ts):

```ts
import { EsseClient } from './client/index';

const esse = new EsseClient({ apiKey: process.env.ESSE_API_KEY! });
const result = await esse.recommend({ song: 'Perfect', artist: 'Ed Sheeran', limit: 5 });

for (const song of result.recommendations) {
  console.log(`${song.title} — ${song.artist}`);
}
```

`EsseApiError` exposes safe `kind`, HTTP `status`, public error `code`, and `requestId` fields where available. The client uses native fetch, defaults to a 30-second abort timeout, and does not retry.

## Music-bot handler sketch

Call ESSE when a track starts, then display or queue the returned suggestions using the bot framework of your choice:

```ts
async function onTrackStarted(chatId: string, currentTrack: { title: string; artist?: string }) {
  const result = await esse.recommend({ song: currentTrack.title, artist: currentTrack.artist, limit: 5 });
  await sendSuggestions(chatId, result.recommendations);
}
```

## Security, limits, and cache

- Keep the API key server-side. Do not embed it in browser/mobile apps or commit it to GitHub; use environment variables or your hosting platform's secret store.
- Production currently limits each authenticated client to 60 requests/minute and 10 uncached generations/minute.
- Repeated identical requests may return much faster from cache. Results are fresh for 12 hours; stale results may be served while the Worker refreshes them internally, with retention up to 3 days.
- A request has no CORS allowance by default. Call the API from your server or deliberately configure a trusted proxy for browser clients.
