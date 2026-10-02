import { beforeEach, expect, it, vi } from 'vitest';
import { cachedRecommendation, recommendationCacheConfig, RECOMMENDATION_CACHE, resetRecommendationInflight, WorkerRecommendationCache } from '../src/recommendation-cache';
import type { RecommendInput, RecommendOutput } from '../src/types';

class MemoryCache {
  values = new Map<string, Response>();
  async match(key: Request) { return this.values.get(key.url)?.clone(); }
  async put(key: Request, value: Response) { this.values.set(key.url, value.clone()); }
}
const input = (title = 'Seed', artist = 'Artist', limit = 5): RecommendInput => ({ seed: { title, artist }, limit });
const output = (request: RecommendInput): RecommendOutput => ({ seed: request.seed, recommendations: [{ title: 'Next', artist: 'Other' }], count: 1 });
const config = recommendationCacheConfig({});
const make = (store = new MemoryCache(), now = () => 1000) => ({ store, cache: new WorkerRecommendationCache(store as unknown as Cache, config, now) });
beforeEach(() => resetRecommendationInflight());

it('executes a miss once, then serves an identical request without provider work', async () => {
  const { cache } = make(); const llm = vi.fn(async () => undefined); const youtube = vi.fn(async () => undefined);
  const run = vi.fn(async () => { await llm(); await youtube(); return output(input()); }); const states: string[] = [];
  expect(await cachedRecommendation(input(), run, cache, undefined, state => states.push(state))).toEqual(output(input()));
  expect(await cachedRecommendation(input(), run, cache, undefined, state => states.push(state))).toEqual(output(input()));
  expect(run).toHaveBeenCalledTimes(1); expect(llm).toHaveBeenCalledOnce(); expect(youtube).toHaveBeenCalledOnce(); expect(states).toEqual(['miss', 'hit']);
});
it('separates seed, artist, limit, and cache version identities', async () => {
  const store = new MemoryCache(); const first = make(store).cache; const versioned = new WorkerRecommendationCache(store as unknown as Cache, { ...config, version: 'v1' }, () => 1000);
  const run = vi.fn(async () => output(input()));
  await cachedRecommendation(input(), run, first);
  await cachedRecommendation(input('Other'), run, first);
  await cachedRecommendation(input('Seed', 'Other'), run, first);
  await cachedRecommendation(input('Seed', 'Artist', 4), run, first);
  await cachedRecommendation(input(), run, versioned);
  expect(run).toHaveBeenCalledTimes(5);
  expect(RECOMMENDATION_CACHE.version).toBe('v3');
});
it('partitions identical requests by explicit environment and canonicalizes title and artist', async () => {
  const store = new MemoryCache();
  const production = new WorkerRecommendationCache(store as unknown as Cache, recommendationCacheConfig({ ENVIRONMENT: 'production' }));
  const staging = new WorkerRecommendationCache(store as unknown as Cache, recommendationCacheConfig({ ENVIRONMENT: 'staging' }));
  const request = input('  SÉED   Name ', '  ARTÍST  ', 4);
  const productionKey = await production.key(request);
  const productionEquivalentKey = await production.key(input('seed name', 'artist', 4));
  const stagingKey = await staging.key(request);
  expect(productionKey.url).toContain('/production/v3/');
  expect(stagingKey.url).toContain('/staging/v3/');
  expect(productionKey.url).toBe(productionEquivalentKey.url);
  expect(productionKey.url).not.toBe(stagingKey.url);
  expect(productionKey.url).not.toBe((await production.key(input('seed name', 'artist', 5))).url);
});
it('keeps cache entries provider-independent within one environment', async () => {
  const { cache } = make(); const request = input();
  const gemini = vi.fn(async () => output(request));
  const elite = vi.fn(async () => ({ ...output(request), recommendations: [{ title: 'Different', artist: 'Other' }] }));
  await cachedRecommendation(request, gemini, cache);
  const cached = await cachedRecommendation(request, elite, cache);
  expect(cached).toEqual(output(request));
  expect(gemini).toHaveBeenCalledOnce();
  expect(elite).not.toHaveBeenCalled();
});
it('does not include credentials in the synthetic cache key', async () => {
  const env = { ENVIRONMENT: 'production', RECOMMENDATION_CACHE_VERSION: 'v3', GEMINI_API_KEY: 'gemini-secret', ESSE_API_KEYS: 'client-secret' };
  const secretBearingEnv = env as Parameters<typeof recommendationCacheConfig>[0];
  const cache = new WorkerRecommendationCache(new MemoryCache() as unknown as Cache, recommendationCacheConfig(secretBearingEnv));
  const key = (await cache.key(input())).url;
  expect(key).not.toContain(env.GEMINI_API_KEY);
  expect(key).not.toContain(env.ESSE_API_KEYS);
});
it('does not cache failures or malformed/zero results', async () => {
  const { cache } = make();
  const failed = vi.fn(async () => { throw new Error('upstream'); });
  await expect(cachedRecommendation(input(), failed, cache)).rejects.toThrow('upstream');
  await expect(cachedRecommendation(input(), failed, cache)).rejects.toThrow('upstream');
  expect(failed).toHaveBeenCalledTimes(2);
  const malformed = vi.fn(async () => ({ seed: input().seed, recommendations: [], count: 0 }));
  await cachedRecommendation(input(), malformed, cache); await cachedRecommendation(input(), malformed, cache);
  expect(malformed).toHaveBeenCalledTimes(2);
});
it('returns stale data immediately and schedules one protected refresh', async () => {
  let now = 1000; const { cache } = make(new MemoryCache(), () => now); const request = input();
  await cache.put(request, output(request)); now += (config.softTtlSeconds + 1) * 1000;
  const refresh = vi.fn(async () => ({ ...output(request), recommendations: [{ title: 'Fresh', artist: 'Other' }] }));
  const waits: Promise<unknown>[] = []; const states: string[] = [];
  const result = await cachedRecommendation(request, refresh, cache, { waitUntil: promise => waits.push(promise) }, state => states.push(state));
  expect(result.recommendations[0]!.title).toBe('Next'); expect(states).toEqual(['stale']);
  await waits[0]; expect(refresh).toHaveBeenCalledTimes(1);
  expect((await cache.get(request))?.result.recommendations[0]!.title).toBe('Fresh');
});
it('treats hard-expired entries as misses', async () => {
  let now = 1000; const { cache } = make(new MemoryCache(), () => now); const request = input(); await cache.put(request, output(request));
  now += (config.hardTtlSeconds + 1) * 1000; const run = vi.fn(async () => output(request));
  await cachedRecommendation(request, run, cache); expect(run).toHaveBeenCalledOnce();
});
it('coalesces identical misses but not different requests', async () => {
  let release!: (value: RecommendOutput) => void; const pending = new Promise<RecommendOutput>(resolve => { release = resolve; }); const run = vi.fn(() => pending);
  const one = cachedRecommendation(input(), run); const two = cachedRecommendation(input(), run); const otherRun = vi.fn(async () => output(input('Other')));
  const other = cachedRecommendation(input('Other'), otherRun); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  release(output(input())); expect(await Promise.all([one, two])).toEqual([output(input()), output(input())]); await other;
  expect(otherRun).toHaveBeenCalledOnce();
});
it('cleans up a failed in-flight request', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(output(input()));
  await expect(cachedRecommendation(input(), run)).rejects.toThrow('failed');
  await expect(cachedRecommendation(input(), run)).resolves.toEqual(output(input()));
  expect(run).toHaveBeenCalledTimes(2);
});
