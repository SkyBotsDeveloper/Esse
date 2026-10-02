import { AppError } from './errors';
import { readInput } from './validation';
import { recommend } from './service';
import { GeminiProvider, parseFallbackModels } from './providers/gemini';
import type { GeminiAttempt } from './providers/gemini-http';
import { ELITE_DEFAULTS, EliteProvider, type EliteAttempt } from './providers/elite';
import { OrderedRecommendationProvider, parseProviderOrder, type ProviderOrderEvent, type ProviderName } from './providers/order';
import { YouTubeProvider } from './providers/youtube';
import { CachedVerificationProvider, WorkerVerificationCache } from './cache';
import { authenticatedClientFingerprint } from './auth';
import { cachedRecommendation, recommendationCacheConfig, WorkerRecommendationCache, type RecommendationCacheObserver, type WaitUntilContext } from './recommendation-cache';
import type { Env, RecommendationProvider, VerificationProvider } from './types';
import { createDiagnostics, type Diagnostics } from './diagnostics';

export interface Providers { brain: RecommendationProvider; verifier: VerificationProvider; resultCache?: WorkerRecommendationCache; cacheObserver?: RecommendationCacheObserver; providerOrder?: readonly ProviderName[]; providerEvents?: () => readonly ProviderOrderEvent[] }
function providers(env: Env, request: Request, observeGemini: (attempt: GeminiAttempt) => void, observeElite: (attempt: EliteAttempt) => void): Providers {
  let order: ProviderName[];
  try { order = parseProviderOrder(env.LLM_PROVIDER_ORDER); }
  catch { throw new AppError(503, 'NOT_CONFIGURED', 'Recommendation service is not configured.'); }
  const youtube = new YouTubeProvider();
  let fallbacks: string[];
  try { fallbacks = parseFallbackModels(env.GEMINI_FALLBACK_MODELS); }
  catch { throw new AppError(503, 'NOT_CONFIGURED', 'Recommendation service is not configured.'); }
  let resultCache: WorkerRecommendationCache | undefined;
  if (typeof caches !== 'undefined') {
    let config;
    try { config = recommendationCacheConfig(env); }
    catch { throw new AppError(503, 'NOT_CONFIGURED', 'Recommendation service is not configured.'); }
    resultCache = new WorkerRecommendationCache(caches.default, config);
  }
  const available: Partial<Record<ProviderName, RecommendationProvider>> = {};
  if (env.GEMINI_API_KEY?.trim() && env.GEMINI_MODEL?.trim()) available.gemini = new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, fetch, observeGemini, fallbacks);
  if (env.ELITE_API_KEY?.trim()) {
    const timeoutMs = env.ELITE_TIMEOUT_MS === undefined ? ELITE_DEFAULTS.timeoutMs : Number(env.ELITE_TIMEOUT_MS);
    available.elite = new EliteProvider(env.ELITE_API_KEY, env.ELITE_MODEL?.trim() || ELITE_DEFAULTS.model,
      env.ELITE_BASE_URL?.trim() || ELITE_DEFAULTS.baseUrl, fetch, observeElite, timeoutMs);
  }
  if (!order.some(name => available[name])) throw new AppError(503, 'NOT_CONFIGURED', 'Recommendation service is not configured.');
  const brain = new OrderedRecommendationProvider(order, available);
  return {
    brain, providerOrder: order, providerEvents: () => brain.events,
    resultCache,
    verifier: typeof caches === 'undefined' ? youtube : new CachedVerificationProvider(youtube, new WorkerVerificationCache(caches.default, new URL(request.url).origin))
  };
}

const json = (body: unknown, requestId: string, status = 200, headers: Record<string, string> = {}) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId, ...headers }
});

function publicFailure(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof AppError) {
    if (error.status === 401) return { status: 401, code: 'unauthorized', message: 'Unauthorized.' };
    if (error.status === 400 || error.status === 415) return { status: error.status, code: 'invalid_request', message: error.message };
    if (error.status === 429) return { status: 429, code: 'rate_limited', message: 'Too many requests.' };
    if (error.status === 404) return { status: 404, code: 'not_found', message: 'Route not found.' };
    if (error.status === 405) return { status: 405, code: 'method_not_allowed', message: 'Method not allowed.' };
    if (error.status >= 500 && (error.code.startsWith('UPSTREAM_') || error.code === 'INVALID_UPSTREAM_RESPONSE')) return { status: error.status, code: 'upstream_unavailable', message: 'Recommendation service is temporarily unavailable.' };
    return { status: error.status >= 500 ? 503 : error.status, code: 'internal_error', message: 'An unexpected error occurred.' };
  }
  return { status: 500, code: 'internal_error', message: 'An unexpected error occurred.' };
}

async function consumeLimiter(limiter: RateLimit, key: string): Promise<void> {
  let allowed: boolean;
  try { allowed = (await limiter.limit({ key })).success; }
  catch { throw new AppError(503, 'RATE_LIMITER_UNAVAILABLE', 'Service is temporarily unavailable.'); }
  if (!allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many requests.');
}

export async function handleRequest(request: Request, env: Env, injected?: Providers, ctx?: WaitUntilContext): Promise<Response> {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  const path = new URL(request.url).pathname;
  const route = path === '/health' || path === '/v1/recommend' ? path : 'other';
  const geminiEvents: GeminiAttempt[] = [];
  const eliteEvents: EliteAttempt[] = [];
  let diagnostics: Diagnostics | undefined;
  let cacheStatus = 'not-applicable';
  let recommendationCount = 0;
  let rateLimited = false;
  let response: Response | undefined;
  let errorCategory: string | null = null;
  let configuredProviderOrder: readonly ProviderName[] = [];
  let providerEvents: readonly ProviderOrderEvent[] = [];
  let providerOrderBrain: OrderedRecommendationProvider | undefined;
  try {
    if (route === 'other') throw new AppError(404, 'NOT_FOUND', 'Route not found.');
    const expectedMethod = route === '/health' ? 'GET' : 'POST';
    if (request.method !== expectedMethod) throw new AppError(405, 'METHOD_NOT_ALLOWED', `Use ${expectedMethod}.`);
    if (route === '/health') {
      response = json({ status: 'ok' }, requestId);
    } else {
      const fingerprint = await authenticatedClientFingerprint(request, env.ESSE_API_KEYS);
      if (!fingerprint) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized.');
      const clientKey = `client:${fingerprint}`;
      try { await consumeLimiter(env.RECOMMEND_RATE_LIMITER, clientKey); }
      catch (error) { if (error instanceof AppError && error.status === 429) rateLimited = true; throw error; }

      const input = await readInput(request);
      const observeGemini = (event: GeminiAttempt) => { geminiEvents.push(event); };
      const observeElite = (event: EliteAttempt) => { eliteEvents.push(event); };
      const configured = injected ?? providers(env, request, observeGemini, observeElite);
      configuredProviderOrder = configured.providerOrder ?? parseProviderOrder(env.LLM_PROVIDER_ORDER);
      providerEvents = configured.providerEvents?.() ?? [];
      if (configured.brain instanceof OrderedRecommendationProvider) providerOrderBrain = configured.brain;
      const cacheObserver: RecommendationCacheObserver = status => { cacheStatus = status; configured.cacheObserver?.(status); };
      const result = await cachedRecommendation(input, async () => {
        await consumeLimiter(env.RECOMMEND_GENERATION_RATE_LIMITER, clientKey);
        diagnostics = createDiagnostics();
        return recommend(input, configured.brain, configured.verifier, diagnostics);
      }, configured.resultCache, ctx, cacheObserver);
      providerEvents = configured.providerEvents?.() ?? providerEvents;
      recommendationCount = result.count;
      response = json(result, requestId);
    }
  } catch (error) {
    const failure = publicFailure(error);
    errorCategory = failure.code;
    if (failure.status === 429) rateLimited = true;
    response = json({ error: { code: failure.code, message: failure.message, requestId } }, requestId, failure.status,
      failure.code === 'method_not_allowed' ? { allow: route === '/health' ? 'GET' : 'POST' } : {});
  } finally {
    const successfulAttempt = [...geminiEvents].reverse().find((event: GeminiAttempt) => event.outcome === 'success');
    const successfulElite = [...eliteEvents].reverse().find(event => event.outcome === 'success');
    const finalProvider = providerOrderBrain?.successfulProvider ?? (successfulElite ? 'elite' : successfulAttempt ? 'gemini' : null);
    const providerFallbackReason = [...providerEvents].reverse().find(event => event.outcome === 'failure')?.fallbackReason ?? [...eliteEvents].reverse().find(event => event.fallbackReason)?.fallbackReason ?? null;
    console.log(JSON.stringify({
      event: 'request-complete', requestId, route, method: request.method, status: response?.status ?? 500,
      totalLatencyMs: Math.round(performance.now() - started), cacheStatus, recommendationCount,
      provider: finalProvider, model: successfulElite?.model ?? successfulAttempt?.model ?? null,
      configuredProviderOrder, providersAttempted: providerEvents.filter(event => event.outcome === 'success' || event.outcome === 'failure').map(event => event.provider),
      providerCooldownSkips: providerEvents.filter(event => event.outcome === 'cooldown-skip').map(event => event.provider),
      providerFallbackReason, eliteCooldownSkipped: eliteEvents.some(event => event.outcome === 'cooldown-skip'),
      eliteLatencyMs: eliteEvents.filter(event => event.attempt === 1).reduce((sum, event) => sum + event.latencyMs, 0),
      geminiModel: successfulAttempt?.model ?? null, geminiLatencyMs: geminiEvents.reduce((sum, event) => sum + event.latencyMs, 0),
      youtubeVerificationCount: diagnostics?.verificationAttempts ?? 0, rateLimited,
      errorCategory
    }));
  }
  return response!;
}
export default { fetch: (request: Request, env: Env, ctx?: WaitUntilContext) => handleRequest(request, env, undefined, ctx) };
