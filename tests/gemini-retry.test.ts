import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GeminiProvider, resetGeminiModelHealth } from '../src/providers/gemini';
import { safeGeminiError } from '../src/providers/gemini-http';
import type { Fetcher } from '../src/types';

const key = 'test-private-key-123';
const model = 'gemini-3.8-flash';
const seed = { title: 'Ek Vaari Aa', artist: 'Arijit Singh' };
const songs = [{ title: 'Hawayein', artist: 'Arijit Singh', emotionFit: 'strong', energyTempoFit: 'acceptable', sonicFit: 'strong', themeContextFit: 'strong', transitionScore: 91 }] as const;
const profile = { primaryMood: 'longing', secondaryMood: 'hopeful', energy: 'low', tempoFeel: 'slow', relationshipTheme: 'romantic longing', sonicCharacter: 'cinematic acoustic', language: 'Hindi', culturalStyle: 'Bollywood', coreTheme: 'longing', subgenre: 'pop ballad', productionStyle: 'cinematic acoustic', eraFeel: 'contemporary' };
const success = () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ seedProfile: profile, candidates: songs }) }] } }] });
beforeEach(() => { resetGeminiModelHealth(); vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([400, 401, 403, 404])('never retries deterministic HTTP %s', async status => {
  const mock = vi.fn(async () => Response.json({ error: { code: status, status: 'INVALID_ARGUMENT', message: 'Invalid parameters' } }, { status }));
  await expect(new GeminiProvider(key, model, mock as Fetcher).candidates(seed)).rejects.toMatchObject({ status: status === 403 ? 503 : 502 });
  expect(mock).toHaveBeenCalledTimes(1);
});
it.each(['invalid-json', 'invalid-schema'])('does not retry malformed HTTP 200 (%s)', async kind => {
  const mock = vi.fn(async () => kind === 'invalid-json' ? new Response('not JSON') : Response.json({ candidates: [] }));
  await expect(new GeminiProvider(key, model, mock as Fetcher).candidates(seed)).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' });
  expect(mock).toHaveBeenCalledTimes(1);
});
it('does not retry a transient failure when no fallback is configured', async () => {
  const mock = vi.fn(async () => new Response('', { status: 503 }));
  await expect(new GeminiProvider(key, model, mock as Fetcher).candidates(seed)).rejects.toMatchObject({ fallbackEligible: true });
  expect(mock).toHaveBeenCalledTimes(1);
});
it('never prints raw keys, authorization, prompts or arbitrary error text', async () => {
  const mock = vi.fn(async (_url, init) => {
    const prompt = JSON.parse(init!.body as string).systemInstruction.parts[0].text;
    return Response.json({ error: { code: 400, status: `SECRET_${key}`, message: `Invalid JSON payload received. Unknown name "responseFormat": ${key} Authorization: Bearer other-secret ${prompt}`, details: { key } } }, { status: 400 });
  });
  let publicError = '';
  try { await new GeminiProvider(key, model, mock as Fetcher).candidates(seed); } catch (error) { publicError = String(error); }
  const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
  expect(logged).toContain('unknown field responseFormat');
  for (const secret of [key, 'other-secret', 'Authorization', 'You are ESSE', 'systemInstruction']) {
    expect(logged).not.toContain(secret); expect(publicError).not.toContain(secret);
  }
});
it('does not retry a known client error when its diagnostic body cannot be read', async () => {
  const mock = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(key)); } }), { status: 400 }));
  await expect(new GeminiProvider(key, model, mock as Fetcher).candidates(seed)).rejects.toMatchObject({ status: 502 });
  expect(mock).toHaveBeenCalledTimes(1);
});
it('summarizes location restrictions without disclosing caller identifiers', () => {
  expect(safeGeminiError({ error: { code: 400, status: 'FAILED_PRECONDITION', message: `User location is not supported for the API use. ${key}` } })).toEqual({ upstreamCode: 400, upstreamStatus: 'FAILED_PRECONDITION', upstreamMessage: 'Caller location is not supported for this API.' });
});
it('preserves the proven invalid structured-output field path without echoing its value', () => {
  expect(safeGeminiError({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `Invalid value at 'generation_config.response_format.text.mime_type' (type.googleapis.com/example), "application/json" ${key}` } })).toEqual({ upstreamCode: 400, upstreamStatus: 'INVALID_ARGUMENT', upstreamMessage: 'Invalid value at generation_config.response_format.text.mime_type.' });
});
it('returns successful structured output without retrying', async () => {
  const mock = vi.fn(async () => success());
  await expect(new GeminiProvider(key, model, mock as Fetcher).candidates(seed)).resolves.toEqual(songs);
  expect(mock).toHaveBeenCalledTimes(1);
});
