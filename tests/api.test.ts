import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleRequest, type Providers } from '../src/index';
import { validateInput } from '../src/validation';
import { AppError } from '../src/errors';
import type { Env, RecommendationCandidate } from '../src/types';
import { recommendationCacheConfig, resetRecommendationInflight, WorkerRecommendationCache } from '../src/recommendation-cache';

const keyOne = 'client-test-key-alpha-0123456789';
const keyTwo = 'client-test-key-bravo-9876543210';
const limiter = (success = true) => ({ limit: vi.fn(async (_options: { key: string }) => ({ success })) });
const baseRequestLimiter = limiter();
const baseGenerationLimiter = limiter();
const env = {
  ESSE_API_KEYS: ` ${keyOne} , , ${keyTwo} `,
  GEMINI_API_KEY: 'test-gemini-secret', GEMINI_MODEL: 'test-model',
  RECOMMEND_RATE_LIMITER: baseRequestLimiter,
  RECOMMEND_GENERATION_RATE_LIMITER: baseGenerationLimiter
} as unknown as Env;
const withEnv = (overrides: Partial<typeof env> = {}) => ({ ...env, ...overrides }) as Env;
const providers = (): Providers => ({ brain: { candidates: vi.fn(async () => []) }, verifier: { verify: vi.fn(async () => null) } });
const request = (value: unknown, authorization: string | null = `Bearer ${keyOne}`) => new Request('https://esse.test/v1/recommend', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(value)
});
const assessed = (title: string, artist = 'Artist'): RecommendationCandidate => ({ title, artist, emotionFit: 'strong', energyTempoFit: 'strong', sonicFit: 'strong', themeContextFit: 'strong', transitionScore: 80 });
beforeEach(() => resetRecommendationInflight());

describe('input, authentication and HTTP contract', () => {
  it('defaults to five and allows an omitted artist', () => {
    expect(validateInput({ song: ' Seed ' })).toEqual({ seed: { title: 'Seed' }, limit: 5 });
  });
  it.each([1, 2, 3, 4, 5])('accepts limit %s', async limit => {
    expect((await handleRequest(request({ song: 'Seed', limit }), env, providers())).status).toBe(200);
  });
  it('keeps the internal seed profile out of the public response', async () => {
    const p = providers();
    p.brain = { seedProfile: { primaryMood: 'longing', secondaryMood: 'hopeful', energy: 'low', tempoFeel: 'slow', relationshipTheme: 'romantic', sonicCharacter: 'acoustic', language: 'Hindi', culturalStyle: 'Bollywood', coreTheme: 'longing', subgenre: 'pop ballad', productionStyle: 'cinematic acoustic', eraFeel: 'contemporary' }, candidates: vi.fn(async () => []) };
    const response = await handleRequest(request({ song: 'Seed', limit: 1 }), env, p);
    expect(await response.json()).toEqual({ seed: { title: 'Seed' }, recommendations: [], count: 0 });
  });
  it('serves a repeated request from the final cache without Gemini or YouTube work', async () => {
    const stored = new Map<string, Response>();
    const cache = { match: async (key: Request) => stored.get(key.url)?.clone(), put: async (key: Request, value: Response) => { stored.set(key.url, value.clone()); } };
    const brain = { candidates: vi.fn(async () => [assessed('Next', 'Other')]) };
    const verifier = { verify: vi.fn(async (song: { title: string; artist: string }) => ({ ...song, videoId: 'abcdefghijk' })) };
    const p = { brain, verifier, resultCache: new WorkerRecommendationCache(cache as unknown as Cache, recommendationCacheConfig({})) };
    expect((await handleRequest(request({ song: 'Seed', limit: 1 }), env, p)).status).toBe(200);
    expect((await handleRequest(request({ song: 'Seed', limit: 1 }), env, p)).status).toBe(200);
    expect(brain.candidates).toHaveBeenCalledOnce();
    expect(verifier.verify).toHaveBeenCalledOnce();
  });
  it.each([0, -1, 6, 100, 1.5, '3', null, true])('rejects limit %s with safe 400 contract', async limit => {
    const p = providers();
    const response = await handleRequest(request({ song: 'Seed', limit }), env, p);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request', requestId: response.headers.get('x-request-id') } });
    expect(p.brain.candidates).not.toHaveBeenCalled();
  });
  it.each([{}, [], null, { song: '' }, { song: 3 }, { song: 'x', artist: '' }, { song: 'x', artist: null }, { song: 'a'.repeat(201) }, { song: 'x\ny' }])('rejects invalid input %j', async value => {
    expect((await handleRequest(request(value), env, providers())).status).toBe(400);
  });
  it('rejects malformed, oversized and non-JSON bodies', async () => {
    const make = (body: string, type: string) => new Request('https://esse.test/v1/recommend', { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${keyOne}` }, body });
    expect((await handleRequest(make('{', 'application/json'), env)).status).toBe(400);
    expect((await handleRequest(make(' '.repeat(4097), 'application/json'), env)).status).toBe(400);
    expect((await handleRequest(make('{}', 'text/plain'), env)).status).toBe(415);
  });
  it('keeps health public and requires bearer authentication for recommend', async () => {
    const response = await worker.fetch(new Request('https://esse.test/health'), env);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect((await worker.fetch(request({ song: 'Seed' }, null), env)).status).toBe(401);
  });
  it.each([null, 'Basic opaque-token', 'Bearer', 'Bearer key with spaces'])('rejects missing or malformed authorization with 401', async authorization => {
    const response = await handleRequest(request({ song: 'Seed' }, authorization), env, providers());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized', message: 'Unauthorized.' } });
  });
  it('accepts either configured client key and proceeds through injected providers', async () => {
    for (const key of [keyOne, keyTwo]) {
      const p = providers();
      const response = await handleRequest(request({ song: 'Seed' }, `Bearer ${key}`), env, p);
      expect(response.status).toBe(200);
      expect(p.brain.candidates).toHaveBeenCalledOnce();
    }
  });
  it('rejects invalid credentials without exposing them or calling the limiter/provider', async () => {
    const invalidKey = 'private-invalid-client-token';
    const requestLimiter = limiter(); const p = providers();
    const response = await handleRequest(request({ song: 'Seed' }, `Bearer ${invalidKey}`), withEnv({ RECOMMEND_RATE_LIMITER: requestLimiter }), p);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(invalidKey);
    expect(requestLimiter.limit).not.toHaveBeenCalled();
    expect(p.brain.candidates).not.toHaveBeenCalled();
  });
  it('preserves route errors and Allow headers', async () => {
    expect((await handleRequest(new Request('https://esse.test/missing'), env)).status).toBe(404);
    const response = await handleRequest(new Request('https://esse.test/v1/recommend'), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
  it('maps upstream and unexpected failures into safe public errors', async () => {
    for (const [error, status, code] of [[new AppError(503, 'UPSTREAM_UNAVAILABLE', 'Gemini key should not appear.'), 503, 'upstream_unavailable'], [new Error('secret-key'), 500, 'internal_error']] as const) {
      const p = providers();
      p.brain.candidates = vi.fn().mockRejectedValue(error);
      const response = await handleRequest(request({ song: 'Seed' }), env, p);
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code, requestId: response.headers.get('x-request-id') } });
      expect(JSON.stringify(body)).not.toContain('secret-key');
      expect(JSON.stringify(body)).not.toContain('Gemini key should not appear');
    }
  });
});

describe('native rate limits and request observability', () => {
  it('limits authenticated requests before parsing or providers', async () => {
    const requestLimiter = limiter(false), generationLimiter = limiter(); const p = providers();
    const response = await handleRequest(request({ song: 'Seed', limit: 6 }), withEnv({ RECOMMEND_RATE_LIMITER: requestLimiter, RECOMMEND_GENERATION_RATE_LIMITER: generationLimiter }), p);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(p.brain.candidates).not.toHaveBeenCalled();
    expect(generationLimiter.limit).not.toHaveBeenCalled();
  });
  it('uses different hashed limiter identities for distinct authenticated clients', async () => {
    const requestLimiter = limiter();
    await handleRequest(request({ song: 'Seed' }, `Bearer ${keyOne}`), withEnv({ RECOMMEND_RATE_LIMITER: requestLimiter }), providers());
    await handleRequest(request({ song: 'Seed' }, `Bearer ${keyTwo}`), withEnv({ RECOMMEND_RATE_LIMITER: requestLimiter }), providers());
    const keys = requestLimiter.limit.mock.calls.map(call => call[0].key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.join(' ')).not.toContain(keyOne);
    expect(keys.join(' ')).not.toContain(keyTwo);
  });
  it('consumes generation allowance on cache misses, but not cache hits', async () => {
    const stored = new Map<string, Response>();
    const cache = { match: async (key: Request) => stored.get(key.url)?.clone(), put: async (key: Request, value: Response) => { stored.set(key.url, value.clone()); } };
    const generationLimiter = limiter();
    const brain = { candidates: vi.fn(async () => [assessed('Next', 'Other')]) };
    const verifier = { verify: vi.fn(async (song: { title: string; artist: string }) => ({ ...song, videoId: 'abcdefghijk' })) };
    const p = { brain, verifier, resultCache: new WorkerRecommendationCache(cache as unknown as Cache, recommendationCacheConfig({})) };
    expect((await handleRequest(request({ song: 'Cache seed' }), withEnv({ RECOMMEND_GENERATION_RATE_LIMITER: generationLimiter }), p)).status).toBe(200);
    expect(generationLimiter.limit).toHaveBeenCalledOnce();
    const generationKey = generationLimiter.limit.mock.calls[0]![0].key;
    expect(generationKey).not.toContain(keyOne);
    expect(generationKey).not.toContain(keyTwo);
    expect((await handleRequest(request({ song: 'Cache seed' }), withEnv({ RECOMMEND_GENERATION_RATE_LIMITER: generationLimiter }), p)).status).toBe(200);
    expect(generationLimiter.limit).toHaveBeenCalledOnce();
  });
  it('rejects a cold generation before Gemini/provider work when its allowance is exhausted', async () => {
    const generationLimiter = limiter(false); const p = providers();
    const response = await handleRequest(request({ song: 'Cold seed' }), withEnv({ RECOMMEND_GENERATION_RATE_LIMITER: generationLimiter }), p);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(p.brain.candidates).not.toHaveBeenCalled();
  });
  it('emits one safe completion event with a request ID and no credentials or request body', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const sentinel = 'private-song-body-sentinel';
      const response = await handleRequest(request({ song: sentinel }), env, providers());
      const body = await response.json();
      expect(body).toEqual({ seed: { title: sentinel }, recommendations: [], count: 0 });
      expect(log).toHaveBeenCalledOnce();
      const event = JSON.parse(String(log.mock.calls[0]![0]));
      expect(event).toMatchObject({ event: 'request-complete', route: '/v1/recommend', method: 'POST', status: 200, cacheStatus: 'bypass', recommendationCount: 0, youtubeVerificationCount: 0, rateLimited: false, errorCategory: null });
      expect(event.requestId).toBe(response.headers.get('x-request-id'));
      const serialized = JSON.stringify(event);
      for (const secret of [keyOne, keyTwo, 'test-gemini-secret', 'Authorization', sentinel, 'systemInstruction']) expect(serialized).not.toContain(secret);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    } finally { log.mockRestore(); }
  });
  it('records the successful Gemini model and latency without logging the generation request', async () => {
    const profile = { primaryMood: 'hopeful', secondaryMood: 'warm', energy: 'moderate', tempoFeel: 'mid-tempo', relationshipTheme: 'none', sonicCharacter: 'bright pop', language: 'English', culturalStyle: 'global pop', coreTheme: 'celebration', subgenre: 'pop', productionStyle: 'polished', eraFeel: 'current' };
    const generated = { seedProfile: profile, candidates: [] };
    const upstream = vi.fn(async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(generated) }] } }] }));
    vi.stubGlobal('fetch', upstream);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const response = await handleRequest(request({ song: 'private-generation-seed' }), env);
      expect(response.status).toBe(200);
      expect(log).toHaveBeenCalledOnce();
      const event = JSON.parse(String(log.mock.calls[0]![0]));
      expect(event).toMatchObject({ event: 'request-complete', geminiModel: 'test-model', youtubeVerificationCount: 0, rateLimited: false });
      expect(typeof event.geminiLatencyMs).toBe('number');
      const serialized = JSON.stringify(event);
      for (const secret of ['test-gemini-secret', keyOne, keyTwo, 'You are ESSE', 'systemInstruction', 'private-generation-seed']) expect(serialized).not.toContain(secret);
    } finally { log.mockRestore(); vi.unstubAllGlobals(); }
  });
});
