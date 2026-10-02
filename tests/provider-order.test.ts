import { expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import { DEFAULT_PROVIDER_ORDER, OrderedRecommendationProvider, parseProviderOrder, type ProviderName } from '../src/providers/order';
import type { RecommendationCandidate, RecommendationProvider } from '../src/types';

const song: RecommendationCandidate = { title: 'Next', artist: 'Singer', emotionFit: 'strong', energyTempoFit: 'strong', sonicFit: 'strong', themeContextFit: 'strong', transitionScore: 90 };
const provider = (candidates: RecommendationProvider['candidates'], isCoolingDown = false): RecommendationProvider & { isCoolingDown: boolean } => ({ candidates, isCoolingDown });

it('defaults to Gemini then Elite and normalizes configured ordering deterministically', () => {
  expect(parseProviderOrder()).toEqual(['gemini', 'elite']);
  expect(DEFAULT_PROVIDER_ORDER).toEqual(['gemini', 'elite']);
  expect(parseProviderOrder(' elite , gemini ')).toEqual(['elite', 'gemini']);
  expect(parseProviderOrder('elite,gemini,elite')).toEqual(['elite', 'gemini']);
});

it.each(['other,gemini', '', ' , , '])('rejects unusable provider order configuration %j', value => {
  expect(() => parseProviderOrder(value)).toThrow(/provider order/i);
});

it('stops after first valid provider and respects Elite then Gemini order', async () => {
  const elite = provider(vi.fn(async () => [song]));
  const gemini = provider(vi.fn(async () => [song]));
  const brain = new OrderedRecommendationProvider(['elite', 'gemini'], { elite, gemini });
  await expect(brain.candidates({ title: 'Seed' })).resolves.toEqual([song]);
  expect(elite.candidates).toHaveBeenCalledOnce();
  expect(gemini.candidates).not.toHaveBeenCalled();
  expect(brain.successfulProvider).toBe('elite');
  expect(brain.events).toEqual([{ provider: 'elite', outcome: 'success' }]);
});

it('falls through after failure and records safe diagnostics without error or secret text', async () => {
  const gemini = provider(vi.fn(async () => { throw new AppError(503, 'UPSTREAM_TIMEOUT', 'private upstream detail secret-value'); }));
  const elite = provider(vi.fn(async () => [song]));
  const brain = new OrderedRecommendationProvider(['gemini', 'elite'], { gemini, elite });
  await expect(brain.candidates({ title: 'Seed' })).resolves.toEqual([song]);
  expect(gemini.candidates).toHaveBeenCalledOnce();
  expect(elite.candidates).toHaveBeenCalledOnce();
  expect(brain.events).toEqual([
    { provider: 'gemini', outcome: 'failure', fallbackReason: 'timeout' },
    { provider: 'elite', outcome: 'success' }
  ]);
  expect(JSON.stringify(brain.events)).not.toMatch(/secret-value|private upstream detail/);
});

it('skips a cooling provider and records the cooldown skip', async () => {
  const elite = provider(vi.fn(async () => [song]), true);
  const gemini = provider(vi.fn(async () => [song]));
  const brain = new OrderedRecommendationProvider(['elite', 'gemini'], { elite, gemini });
  await brain.candidates({ title: 'Seed' });
  expect(elite.candidates).not.toHaveBeenCalled();
  expect(gemini.candidates).toHaveBeenCalledOnce();
  expect(brain.events).toEqual([{ provider: 'elite', outcome: 'cooldown-skip', fallbackReason: 'cooldown' }, { provider: 'gemini', outcome: 'success' }]);
});

it('uses the next configured provider when an earlier one is not usable and fails if none are usable', async () => {
  const elite = provider(vi.fn(async () => [song]));
  const brain = new OrderedRecommendationProvider(['gemini', 'elite'], { elite });
  await brain.candidates({ title: 'Seed' });
  expect(brain.events[0]).toEqual({ provider: 'gemini', outcome: 'not-configured', fallbackReason: 'provider configuration unavailable' });
  const empty = new OrderedRecommendationProvider(['gemini'] as ProviderName[], {});
  await expect(empty.candidates({ title: 'Seed' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
});
