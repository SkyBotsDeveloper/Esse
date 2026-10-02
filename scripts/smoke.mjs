import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8787';
let configuredKeys = process.env.SMOKE_API_KEY;
if (!configuredKeys) {
  try { configuredKeys = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')).ESSE_API_KEYS; }
  catch { /* The caller may provide SMOKE_API_KEY directly. */ }
}
const apiKey = configuredKeys?.split(',').map(key => key.trim()).find(Boolean);

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: 'ok' });

const post = (authorization, body = { song: 'Seed' }) => fetch(`${base}/v1/recommend`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body)
});
const unauthorized = await post(undefined);
assert.equal(unauthorized.status, 401);
assert.equal((await unauthorized.json()).error.code, 'unauthorized');
const malformed = await post('Basic invalid');
assert.equal(malformed.status, 401);
const invalidCredential = await post('Bearer invalid-smoke-credential');
assert.equal(invalidCredential.status, 401);
if (apiKey) {
  const authorized = await post(`Bearer ${apiKey}`, { song: 'Seed', limit: 6 });
  assert.equal(authorized.status, 400);
  const error = await authorized.json();
  assert.equal(error.error.code, 'invalid_request');
  assert.equal(authorized.headers.get('x-request-id'), error.error.requestId);
  assert.equal(authorized.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(authorized.headers.get('cache-control'), 'no-store');
}
console.log(`Worker smoke checks passed: public health, auth failures, safe error headers.${apiKey ? ' Valid-key routing also passed.' : ' Valid-key routing skipped; configure ESSE_API_KEYS to enable it.'}`);
