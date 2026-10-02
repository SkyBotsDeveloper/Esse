# Current state

ESSE is a TypeScript Cloudflare Worker. Production is `esse` at `https://esse.skybotsdeveloper.workers.dev`, deployed as version `b0f5efb5-9a7e-45a8-96e9-250f01182799`. Staging is the separate `esse-staging` Worker at `https://esse-staging.skybotsdeveloper.workers.dev`; production and staging use separate rate-limit bindings and recommendation-cache environments.

The public API is `GET /health` and authenticated `POST /v1/recommend`. Recommendation requests use a bearer key from `ESSE_API_KEYS`; public responses contain the seed, verified recommendations and count. See [API.md](API.md) for the contract and examples, [openapi.yaml](openapi.yaml) for the machine-readable schema, and [client/index.ts](client/index.ts) for the dependency-free TypeScript client.

Production provider order is configurable with `LLM_PROVIDER_ORDER`, defaulting to `gemini,elite`; `elite,gemini` is supported. Providers use the same prompt and strict canonical validation. The final-result cache is provider-independent, uses version `v3`, and partitions synthetic cache keys by runtime environment. Successful verified results are fresh for 12 hours and retained for up to 3 days; evaluation bypasses this cache.

YouTube verification uses isolated, keyless Innertube search. Provider diagnostics and internal transition assessments are not part of the public response. Credentials belong in ignored local `.dev.vars` or Worker secrets and must not be committed.

Development requires Node 22.12+. Run `npm run typecheck`, `npm test`, and `npm run build` for local validation. The most recent production validation used an authenticated cold request and its cached repeat; no push or deployment is part of this checkpoint.
