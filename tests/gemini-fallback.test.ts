import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GEMINI_ATTEMPT_TIMEOUT_MS, GEMINI_OVERALL_DEADLINE_MS, GeminiProvider, geminiModelHealth, parseFallbackModels, resetGeminiModelHealth } from '../src/providers/gemini';
import type { GeminiAttempt } from '../src/providers/gemini-http';
import type { Fetcher } from '../src/types';

const key = 'test-key';
const primary = 'gemini-3.8-flash';
const fallbacks = ['gemini-3.7-flash', 'gemini-3.5-flash-lite'];
const seed = { title: 'Seed', artist: 'Artist' };
const songs = [{ title: 'Next', artist: 'Other', emotionFit: 'strong', energyTempoFit: 'strong', sonicFit: 'strong', themeContextFit: 'acceptable', transitionScore: 90 }] as const;
const profile = { primaryMood: 'longing', secondaryMood: 'hopeful', energy: 'low', tempoFeel: 'slow', relationshipTheme: 'romantic longing', sonicCharacter: 'cinematic acoustic', language: 'Hindi', culturalStyle: 'Bollywood', coreTheme: 'longing', subgenre: 'pop ballad', productionStyle: 'cinematic acoustic', eraFeel: 'contemporary' };
const ok = () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ seedProfile: profile, candidates: songs }) }] } }] });
const unavailable = () => Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'High demand.' } }, { status: 503 });
const modelFrom = (url: string) => decodeURIComponent(/\/models\/([^:]+):/.exec(url)?.[1] ?? '');

beforeEach(() => { resetGeminiModelHealth(); vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('primary success never calls a fallback and uses low thinking', async () => {
  const events: GeminiAttempt[] = [];
  const fetcher = vi.fn(async () => ok());
  expect(await new GeminiProvider(key, primary, fetcher as Fetcher, event => events.push(event), fallbacks).candidates(seed)).toEqual(songs);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(events[0]).toMatchObject({ model: primary, thinkingLevel: 'low', outcome: 'success' });
});
it('explicit 503 promptly gives the low-thinking quality fallback one chance', async () => {
  const bodies: any[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return modelFrom(url) === primary ? unavailable() : ok(); });
  expect(await new GeminiProvider(key, primary, fetcher as Fetcher, undefined, fallbacks).candidates(seed)).toEqual(songs);
  expect(fetcher.mock.calls.map(call => modelFrom(call[0]))).toEqual([primary, fallbacks[0]]);
  expect(bodies.map(body => body.generationConfig.thinkingConfig.thinkingLevel)).toEqual(['low', 'low']);
});
it('uses minimal thinking only for Flash-Lite and stops at its success', async () => {
  const bodies: any[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return modelFrom(url) === fallbacks[1] ? ok() : unavailable(); });
  expect(await new GeminiProvider(key, primary, fetcher as Fetcher, undefined, fallbacks).candidates(seed)).toEqual(songs);
  expect(fetcher.mock.calls.map(call => modelFrom(call[0]))).toEqual([primary, ...fallbacks]);
  expect(bodies.map(body => body.generationConfig.thinkingConfig.thinkingLevel)).toEqual(['low', 'low', 'minimal']);
  for (const body of bodies) {
    expect(body.generationConfig).not.toHaveProperty('temperature');
    expect(body.generationConfig).not.toHaveProperty('topP');
    expect(body.generationConfig).not.toHaveProperty('topK');
  }
});
it('applies an explicit evaluation thinking override to the selected request', async () => {
  const events: GeminiAttempt[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body)).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    return ok();
  });
  await new GeminiProvider(key, 'gemini-3.5-flash-lite', fetcher as Fetcher, event => events.push(event), [], 'low').candidates(seed);
  expect(events[0]).toMatchObject({ model: 'gemini-3.5-flash-lite', thinkingLevel: 'low', outcome: 'success' });
});
it('applies an evaluation-only attempt timeout without changing the production constant', async () => {
  expect(GEMINI_ATTEMPT_TIMEOUT_MS).toBe(6500);
  const events: GeminiAttempt[] = [];
  const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
  const result = new GeminiProvider(key, 'gemini-3.5-flash-lite', fetcher as Fetcher, event => events.push(event), [], 'low', 12000).candidates(seed);
  const check = expect(result).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(11999);
  expect(events).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  await check;
  expect(events[0]).toMatchObject({ model: 'gemini-3.5-flash-lite', outcome: 'timeout', latencyMs: 12000 });
});
it.each([400, 401, 403])('does not fallback after deterministic HTTP %s', async status => {
  const fetcher = vi.fn(async () => Response.json({ error: { code: status, status: 'INVALID_ARGUMENT', message: 'Invalid request.' } }, { status }));
  await expect(new GeminiProvider(key, primary, fetcher as Fetcher, undefined, fallbacks).candidates(seed)).rejects.toMatchObject({ status: status === 403 ? 503 : 502 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('tries models once in configured order and never starts a second carousel', async () => {
  const fetcher = vi.fn(async (_url: string) => unavailable());
  await expect(new GeminiProvider(key, primary, fetcher as Fetcher, undefined, fallbacks).candidates(seed)).rejects.toMatchObject({ status: 502, fallbackEligible: true });
  expect(fetcher.mock.calls.map(call => modelFrom(call[0]))).toEqual([primary, ...fallbacks]);
});
it('uses one shared bounded deadline', async () => {
  const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
  const result = expect(new GeminiProvider(key, primary, fetcher as Fetcher, undefined, fallbacks).candidates(seed)).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(GEMINI_OVERALL_DEADLINE_MS);
  await result;
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it('preserves prompt and schema semantics across models', async () => {
  const bodies: any[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return modelFrom(url) === fallbacks[1] ? ok() : unavailable(); });
  await new GeminiProvider(key, primary, fetcher as Fetcher, undefined, fallbacks).candidates(seed);
  const normalized = bodies.map(body => { const copy = structuredClone(body); delete copy.generationConfig.thinkingConfig; return copy; });
  expect(normalized[1]).toEqual(normalized[0]);
  expect(normalized[2]).toEqual(normalized[0]);
});
it('parses optional fallbacks once, preserving order and removing duplicates', () => {
  expect(parseFallbackModels(undefined)).toEqual([]);
  expect(parseFallbackModels(' gemini-b,gemini-a,gemini-b ')).toEqual(['gemini-b', 'gemini-a']);
  expect(() => parseFallbackModels('valid,bad/model')).toThrow('Invalid Gemini fallback model configuration.');
});
it('skips a recently rate-limited model on the next request in the same isolate', async () => {
  const first = vi.fn(async (url: string) => modelFrom(url) === primary ? new Response('', { status: 429 }) : ok());
  await new GeminiProvider(key, primary, first as Fetcher, undefined, [fallbacks[0]!]).candidates(seed);
  const events: GeminiAttempt[] = [];
  const second = vi.fn(async (_url: string) => ok());
  await new GeminiProvider(key, primary, second as Fetcher, event => events.push(event), [fallbacks[0]!]).candidates(seed);
  expect(second).toHaveBeenCalledOnce();
  expect(modelFrom(second.mock.calls[0]![0])).toBe(fallbacks[0]);
  expect(events[0]).toMatchObject({ model: primary, outcome: 'cooldown-skip' });
});
it('records 503 health, clears it after success, and makes an expired cooldown eligible', async () => {
  const failed = vi.fn(async () => unavailable());
  await expect(new GeminiProvider(key, primary, failed as Fetcher).candidates(seed)).rejects.toMatchObject({ fallbackEligible: true });
  expect(geminiModelHealth(primary)).toMatchObject({ failures: 1, type: 'server' });
  const succeeds = vi.fn(async () => ok());
  await new GeminiProvider(key, primary, succeeds as Fetcher).candidates(seed);
  expect(geminiModelHealth(primary)).toBeUndefined();
  await expect(new GeminiProvider(key, primary, failed as Fetcher).candidates(seed)).rejects.toMatchObject({ fallbackEligible: true });
  await vi.advanceTimersByTimeAsync(10000);
  const ordered = vi.fn(async (url: string) => modelFrom(url) === primary ? ok() : unavailable());
  await new GeminiProvider(key, primary, ordered as Fetcher, undefined, fallbacks).candidates(seed);
  expect(modelFrom(ordered.mock.calls[0]![0])).toBe(primary);
});
it('does not mark deterministic failures as unhealthy', async () => {
  const bad = vi.fn(async () => new Response('', { status: 400 }));
  await expect(new GeminiProvider(key, primary, bad as Fetcher, undefined, fallbacks).candidates(seed)).rejects.toMatchObject({ fallbackEligible: false });
  expect(geminiModelHealth(primary)).toBeUndefined();
  expect(bad).toHaveBeenCalledOnce();
});
it('puts a timed-out model into cooldown and advances to the fallback', async () => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => modelFrom(url) === primary
    ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    : Promise.resolve(ok()));
  const result = new GeminiProvider(key, primary, fetcher as Fetcher, undefined, [fallbacks[0]!]).candidates(seed);
  await vi.advanceTimersByTimeAsync(6500);
  await expect(result).resolves.toEqual(songs);
  expect(geminiModelHealth(primary)).toMatchObject({ failures: 1, type: 'timeout' });
});
