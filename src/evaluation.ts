import { recommend } from './service';
import { createDiagnostics } from './diagnostics';
import { CachedVerificationProvider, type VerificationCache } from './cache';
import type { RecommendInput, RecommendationProvider, VerificationProvider } from './types';
import { AppError } from './errors';

/** CLI-only diagnostics; the public HTTP response remains unchanged. */
export async function evaluate(input: RecommendInput, brain: RecommendationProvider, verifier: VerificationProvider, cache: VerificationCache) {
  const diagnostics = createDiagnostics();
  const cacheStats = { hits: 0, misses: 0 };
  let youtubeMs = 0;
  let youtubeChecks = 0;
  const measured: VerificationProvider = { get lastFailureReason() { return verifier.lastFailureReason; }, get lastFailureDetail() { return verifier.lastFailureDetail; }, verify: async song => {
    youtubeChecks++;
    const start = performance.now();
    try { return await verifier.verify(song); }
    finally { youtubeMs += performance.now() - start; }
  } };
  let result;
  let error: string | undefined;
  try { result = await recommend(input, brain, new CachedVerificationProvider(measured, cache, cacheStats), diagnostics); }
  catch (failure) {
    // Never serialize arbitrary exceptions, upstream bodies, or credential-bearing URLs.
    error = failure instanceof AppError ? `Request failed (HTTP ${failure.status}).` : 'Evaluation failed.';
  }
  return {
    seed: input.seed, requestedCount: input.limit, recommendations: result?.recommendations ?? [],
    error, diagnostics, youtubeChecks, youtubeMs, cache: cacheStats, seedProfile: brain.seedProfile,
    seedEquivalentRejected: diagnostics.rejected.filter(item => item.reason === 'seed-equivalent').length,
    artistDiversityRejected: diagnostics.rejected.filter(item => item.reason === 'artist-diversity').length
  };
}

// Export the real adapters for the Node evaluation runner's bundled entry point.
export { GEMINI_ATTEMPT_TIMEOUT_MS, GeminiProvider, parseFallbackModels, supportsThinkingLevel, thinkingLevelForModel } from './providers/gemini';
export { ELITE_DEFAULTS, EliteProvider, EliteGeminiProvider, resetEliteHealth } from './providers/elite';
export { YouTubeProvider } from './providers/youtube';
export { normalize } from './normalize';
