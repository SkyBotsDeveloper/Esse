# Engineering rules

- ESSE is a next-song recommendation API targeting Cloudflare Workers in TypeScript.
- Return 1–5 requested recommendations, default 5; reject invalid limits with 400. Never return more than requested or five.
- Every returned recording must pass YouTube verification. Exclude the seed and duplicates; exhaust ranked backups before returning fewer. Upstream failure must never produce fabricated fallback songs.
- Seed-song exclusion is based on underlying song identity, not YouTube video identity or exact title strings. Apply `src/identity.ts` before verification and again using verified/upload metadata; retain artist disambiguation for common titles.
- `npm run eval` uses the real pipeline for human quality review; default two seeds. Use `--dry` for network-free validation, and do not run large live evaluations automatically. Keep diagnostics out of public API responses and never record secrets or prompts.
- Preserve emotional next-song quality. Do not substitute genre/popularity shortcuts or same-artist spam for recommendation quality.
- Keep native fetch, modular providers, strict input/output validation, safe errors, and bounded external requests. Avoid unnecessary abstractions or runtime dependencies.
- Production recommendation providers follow `LLM_PROVIDER_ORDER`, default `gemini,elite`; `elite,gemini` remains configurable. The first healthy provider returning a valid canonical result stops traversal. Preserve each provider's failover/cooldown behavior, shared recommendation prompt, strict validation, transition gates and public response.
- `GET /health` is public; `POST /v1/recommend` requires a Bearer key from the `ESSE_API_KEYS` secret and Cloudflare rate-limit bindings. Never log credentials; emit only compact request-completion metadata.
- YouTube verification uses keyless Innertube search only. Keep client context and parsing isolated in `src/providers/innertube.ts`; reject unknown formats safely and add representative fixtures for changes. Never fetch playback/stream data or add a YouTube Data API key requirement.
- Never commit secrets, echo upstream bodies/keys, or push/deploy without task authorization.
- Use Node 22.12+. Run `npm run typecheck`, `npm test`, and `npm run build` after meaningful changes. Tests must mock external boundaries and cover count, identity, verification, and failure invariants.
- Keep README and CONTEXT concise and aligned with real implementation and validation status.
