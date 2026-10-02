import { normalize } from './normalize';
import type { RecommendInput, RecommendOutput } from './types';
import { record, validText } from './validation';

export const RECOMMENDATION_CACHE = { version: 'v3', environment: 'production', softTtlSeconds: 43200, hardTtlSeconds: 259200 } as const;
export type RecommendationCacheStatus = 'hit' | 'stale' | 'miss' | 'bypass';
export type RecommendationCacheObserver = (status: RecommendationCacheStatus) => void;
export interface WaitUntilContext { waitUntil(promise: Promise<unknown>): void }
export interface RecommendationCacheConfig { environment: string; version: string; softTtlSeconds: number; hardTtlSeconds: number }
interface CacheHit { state: 'fresh' | 'stale'; result: RecommendOutput }

export function recommendationCacheConfig(env: { ENVIRONMENT?: string; RECOMMENDATION_CACHE_VERSION?: string; RECOMMENDATION_CACHE_SOFT_TTL_SECONDS?: string; RECOMMENDATION_CACHE_HARD_TTL_SECONDS?: string }): RecommendationCacheConfig {
  const environment = env.ENVIRONMENT?.trim().toLowerCase() || RECOMMENDATION_CACHE.environment;
  const version = env.RECOMMENDATION_CACHE_VERSION?.trim() || RECOMMENDATION_CACHE.version;
  const softTtlSeconds = Number(env.RECOMMENDATION_CACHE_SOFT_TTL_SECONDS ?? RECOMMENDATION_CACHE.softTtlSeconds);
  const hardTtlSeconds = Number(env.RECOMMENDATION_CACHE_HARD_TTL_SECONDS ?? RECOMMENDATION_CACHE.hardTtlSeconds);
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(environment) || !/^[a-zA-Z0-9._-]{1,32}$/.test(version) || !Number.isInteger(softTtlSeconds) || !Number.isInteger(hardTtlSeconds) || softTtlSeconds < 1 || hardTtlSeconds <= softTtlSeconds) throw new Error('Invalid recommendation cache configuration.');
  return { environment, version, softTtlSeconds, hardTtlSeconds };
}

export async function recommendationCacheIdentity(input: RecommendInput, version: string = RECOMMENDATION_CACHE.version, environment: string = RECOMMENDATION_CACHE.environment): Promise<string> {
  const canonical = JSON.stringify([environment, version, normalize(input.seed.title), normalize(input.seed.artist ?? ''), input.limit]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validResult(value: unknown, input: RecommendInput): value is RecommendOutput {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'count,recommendations,seed' || !record(value.seed) || !Array.isArray(value.recommendations) || !Number.isInteger(value.count) || value.count !== value.recommendations.length || value.count < 1 || value.count > input.limit) return false;
  if (!validText(value.seed.title) || (value.seed.artist !== undefined && !validText(value.seed.artist))) return false;
  if (normalize(value.seed.title) !== normalize(input.seed.title) || normalize(typeof value.seed.artist === 'string' ? value.seed.artist : '') !== normalize(input.seed.artist ?? '')) return false;
  return value.recommendations.every(song => record(song) && Object.keys(song).sort().join(',') === 'artist,title' && validText(song.title) && validText(song.artist));
}

export class WorkerRecommendationCache {
  constructor(private cache: Cache, readonly config: RecommendationCacheConfig, private now: () => number = Date.now) {}
  async key(input: RecommendInput): Promise<Request> { return new Request(`https://esse.internal/cache/recommend/${this.config.environment}/${this.config.version}/${await recommendationCacheIdentity(input, this.config.version, this.config.environment)}`); }
  async get(input: RecommendInput): Promise<CacheHit | undefined> {
    const response = await this.cache.match(await this.key(input));
    if (!response) return undefined;
    let value: unknown;
    try { value = await response.json(); } catch { return undefined; }
    if (!record(value) || typeof value.cachedAt !== 'number' || !validResult(value.result, input)) return undefined;
    const age = this.now() - value.cachedAt;
    if (age < 0 || age > this.config.hardTtlSeconds * 1000) return undefined;
    return { state: age <= this.config.softTtlSeconds * 1000 ? 'fresh' : 'stale', result: value.result };
  }
  async put(input: RecommendInput, result: RecommendOutput): Promise<void> {
    if (!validResult(result, input)) return;
    await this.cache.put(await this.key(input), Response.json({ cachedAt: this.now(), result }, { headers: { 'cache-control': `public, max-age=${this.config.hardTtlSeconds}` } }));
  }
}

const inFlight = new Map<string, Promise<RecommendOutput>>();
export function resetRecommendationInflight(): void { inFlight.clear(); }
async function shared(key: string, run: () => Promise<RecommendOutput>): Promise<RecommendOutput> {
  const active = inFlight.get(key);
  if (active) return active;
  const promise = run().finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
  inFlight.set(key, promise);
  return promise;
}

export async function cachedRecommendation(input: RecommendInput, run: () => Promise<RecommendOutput>, cache?: WorkerRecommendationCache, ctx?: WaitUntilContext, observe?: RecommendationCacheObserver): Promise<RecommendOutput> {
  const key = await recommendationCacheIdentity(input, cache?.config.version, cache?.config.environment);
  let hit: CacheHit | undefined;
  if (cache) { try { hit = await cache.get(input); } catch { /* Cache failure is a miss. */ } }
  if (hit?.state === 'fresh') { observe?.('hit'); return hit.result; }
  const generate = () => shared(key, async () => {
    const result = await run();
    if (cache) { try { await cache.put(input, result); } catch { /* Best effort. */ } }
    return result;
  });
  if (hit?.state === 'stale') {
    observe?.('stale');
    const refresh = generate().then(() => undefined, () => undefined);
    if (ctx) ctx.waitUntil(refresh); else void refresh;
    return hit.result;
  }
  observe?.(cache ? 'miss' : 'bypass');
  return generate();
}
