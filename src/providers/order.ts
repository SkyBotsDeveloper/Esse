import { AppError } from '../errors';
import type { RecommendationCandidate, RecommendationProvider, Seed, SeedProfile } from '../types';

export const DEFAULT_PROVIDER_ORDER = ['gemini', 'elite'] as const;
export type ProviderName = 'gemini' | 'elite';
export type ProviderOrderEvent = { provider: ProviderName; outcome: 'success' | 'failure' | 'cooldown-skip' | 'not-configured'; fallbackReason?: string };

export function parseProviderOrder(value?: string): ProviderName[] {
  if (value === undefined) return [...DEFAULT_PROVIDER_ORDER];
  const names = value.split(',').map(name => name.trim()).filter(Boolean);
  if (names.some(name => name !== 'gemini' && name !== 'elite')) throw new Error('Invalid LLM provider order. Use gemini and/or elite.');
  const order = [...new Set(names)] as ProviderName[];
  if (!order.length) throw new Error('LLM provider order must include at least one provider.');
  return order;
}

type Provider = RecommendationProvider & { readonly isCoolingDown?: boolean };
export class OrderedRecommendationProvider implements RecommendationProvider {
  seedProfile?: SeedProfile;
  readonly events: ProviderOrderEvent[] = [];
  successfulProvider?: ProviderName;
  constructor(readonly order: readonly ProviderName[], private readonly available: Partial<Record<ProviderName, Provider>>) {}

  async candidates(seed: Seed): Promise<RecommendationCandidate[]> {
    this.seedProfile = undefined;
    this.successfulProvider = undefined;
    this.events.length = 0;
    let lastError: unknown;
    for (const name of this.order) {
      const provider = this.available[name];
      if (!provider) {
        this.events.push({ provider: name, outcome: 'not-configured', fallbackReason: 'provider configuration unavailable' });
        continue;
      }
      if (provider.isCoolingDown) {
        this.events.push({ provider: name, outcome: 'cooldown-skip', fallbackReason: 'cooldown' });
        continue;
      }
      try {
        const result = await provider.candidates(seed);
        this.seedProfile = provider.seedProfile;
        this.successfulProvider = name;
        this.events.push({ provider: name, outcome: 'success' });
        return result;
      } catch (error) {
        lastError = error;
        const fallbackReason = error instanceof AppError && error.code === 'INVALID_UPSTREAM_RESPONSE' ? 'invalid output'
          : error instanceof AppError && error.code === 'UPSTREAM_TIMEOUT' ? 'timeout'
          : error instanceof AppError && error.code.startsWith('UPSTREAM_') ? 'upstream failure' : 'provider failure';
        this.events.push({ provider: name, outcome: 'failure', fallbackReason });
      }
    }
    if (lastError !== undefined) throw lastError;
    throw new AppError(503, 'NOT_CONFIGURED', 'No recommendation provider is configured.');
  }
}
