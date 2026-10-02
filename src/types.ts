export interface Song { title: string; artist: string }
export type TransitionFit = 'strong' | 'acceptable' | 'weak';
export const TRANSITION_FIT_VALUES = ['strong', 'acceptable', 'weak'] as const satisfies readonly TransitionFit[];
export interface RecommendationCandidate extends Song { emotionFit: TransitionFit; energyTempoFit: TransitionFit; sonicFit: TransitionFit; themeContextFit: TransitionFit; transitionScore: number }
export interface Seed { title: string; artist?: string }
export interface SeedProfile { primaryMood: string; secondaryMood: string; energy: string; tempoFeel: string; relationshipTheme: string; sonicCharacter: string; language: string; culturalStyle: string; coreTheme: string; subgenre: string; productionStyle: string; eraFeel: string }
export const RECOMMENDATION_OUTPUT_FIELDS = ['seedProfile', 'candidates'] as const;
export const RECOMMENDATION_PROFILE_FIELDS = ['primaryMood', 'secondaryMood', 'energy', 'tempoFeel', 'relationshipTheme', 'sonicCharacter', 'language', 'culturalStyle', 'coreTheme', 'subgenre', 'productionStyle', 'eraFeel'] as const;
export const RECOMMENDATION_CANDIDATE_FIELDS = ['title', 'artist', 'emotionFit', 'energyTempoFit', 'sonicFit', 'themeContextFit', 'transitionScore'] as const;
export interface RecommendInput { seed: Seed; limit: number }
export interface RecommendOutput { seed: Seed; recommendations: Song[]; count: number }
export interface VerifiedSong extends Song { videoId: string; upload?: { title: string; channel: string } }
export interface RecommendationProvider { candidates(seed: Seed): Promise<RecommendationCandidate[]>; readonly seedProfile?: SeedProfile }
export type VerificationFailureReason = 'no strong title match' | 'artist mismatch' | 'unwanted version' | 'low confidence' | 'malformed/no usable results';
export interface VerificationProvider { verify(song: Song): Promise<VerifiedSong | null>; readonly lastFailureReason?: VerificationFailureReason; readonly lastFailureDetail?: string }
export interface Env {
  ESSE_API_KEYS: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  ELITE_API_KEY?: string;
  ELITE_BASE_URL?: string;
  ELITE_MODEL?: string;
  ELITE_TIMEOUT_MS?: string;
  LLM_PROVIDER_ORDER?: string;
  ENVIRONMENT?: string;
  RECOMMEND_RATE_LIMITER: RateLimit;
  RECOMMEND_GENERATION_RATE_LIMITER: RateLimit;
  GEMINI_FALLBACK_MODELS?: string;
  RECOMMENDATION_CACHE_VERSION?: string;
  RECOMMENDATION_CACHE_SOFT_TTL_SECONDS?: string;
  RECOMMENDATION_CACHE_HARD_TTL_SECONDS?: string;
}
export type Fetcher = typeof fetch;
export const MAX_CANDIDATES = 20;
