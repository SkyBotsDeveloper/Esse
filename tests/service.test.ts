import { expect, it, vi } from 'vitest';
import { recommend } from '../src/service';
import { createDiagnostics } from '../src/diagnostics';
import type { RecommendationCandidate, Song, TransitionFit } from '../src/types';
import { AppError } from '../src/errors';

const song = (title: string, artist = 'Artist', overrides: Partial<Pick<RecommendationCandidate, 'emotionFit' | 'energyTempoFit' | 'sonicFit' | 'themeContextFit' | 'transitionScore'>> = {}): RecommendationCandidate => ({
  title, artist, emotionFit: 'strong', energyTempoFit: 'strong', sonicFit: 'strong', themeContextFit: 'strong', transitionScore: 80, ...overrides
});
const verified = (s: Song) => ({ ...s, videoId: s.title });

it.each([1, 2, 3, 4, 5])('never returns more than requested (%s) or five', async limit => {
  const verify = vi.fn(async (s: Song) => verified(s));
  const result = await recommend({ seed: { title: 'Seed' }, limit }, { candidates: async () => Array.from({ length: 20 }, (_, i) => song(`Song ${i}`, `Artist ${i}`)) }, { verify });
  expect(result.count).toBe(limit);
  expect(result.recommendations.length).toBeLessThanOrEqual(5);
  expect(verify).toHaveBeenCalledTimes(limit);
  expect(Object.keys(result.recommendations[0]!).sort()).toEqual(['artist', 'title']);
});
it('removes seed, normalized duplicates and failed matches; backups fill the count', async () => {
  const verify = vi.fn(async (s: Song) => s.title === 'Invalid' ? null : verified(s));
  const result = await recommend({ seed: { title: 'Seed Song', artist: 'Original' }, limit: 3 }, {
    candidates: async () => [song(' SEED-SONG ', 'Original'), song('First', 'Artist One'), song('first!', 'Artist One feat. Guest'), song('Invalid', 'Artist Two'), song('Backup', 'Artist Three'), song('Last', 'Artist Four')]
  }, { verify });
  expect(result.recommendations.map(s => s.title)).toEqual(['First', 'Backup', 'Last']);
  expect(verify).toHaveBeenCalledTimes(4);
});
it('deduplicates video IDs and rechecks canonical titles against the seed', async () => {
  const result = await recommend({ seed: { title: 'Seed' }, limit: 5 }, {
    candidates: async () => [song('One'), song('Two'), song('Alias'), song('Three')]
  }, { verify: async s => ({ ...s, title: s.title === 'Alias' ? 'Seed' : s.title, videoId: s.title === 'Two' ? 'One' : s.title }) });
  expect(result.recommendations.map(s => s.title)).toEqual(['One', 'Three']);
});
it('returns fewer only after exhausting a bounded pool', async () => {
  const verify = vi.fn(async () => null);
  const result = await recommend({ seed: { title: 'Seed' }, limit: 5 }, {
    candidates: async () => Array.from({ length: 100 }, (_, i) => song(`Track ${i}`))
  }, { verify });
  expect(result.count).toBe(0);
  expect(verify).toHaveBeenCalledTimes(20);
});
it('does not disguise upstream failure as a successful partial list', async () => {
  await expect(recommend({ seed: { title: 'Seed' }, limit: 2 }, { candidates: async () => [song('One'), song('Two')] }, {
    verify: async s => { if (s.title === 'Two') throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'YouTube unavailable.'); return verified(s); }
  })).rejects.toMatchObject({ status: 503 });
});
it('caps every final artist at two and fills from ranked backups', async () => {
  const candidates = [song('A1', 'Artist A'), song('A2', 'Artist A'), song('A3', 'Artist A'), song('B1', 'Artist B'), song('B2', 'Artist B'), song('C1', 'Artist C')];
  const diagnostics = createDiagnostics();
  const verify = vi.fn(async (s: Song) => verified(s));
  const result = await recommend({ seed: { title: 'Seed', artist: 'Artist A' }, limit: 5 }, { candidates: async () => candidates }, { verify }, diagnostics);
  expect(result.recommendations.map(item => item.title)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1']);
  expect(result.recommendations.filter(item => item.artist === 'Artist A')).toHaveLength(2);
  expect(diagnostics.rejected).toContainEqual({ song: { title: 'A3', artist: 'Artist A' }, reason: 'artist-diversity', transitionScore: 80 });
  expect(verify).toHaveBeenCalledTimes(5);
});
it('rejects seed identity before diversity and never reintroduces it through backups', async () => {
  const diagnostics = createDiagnostics();
  const candidates = [song('Seed', 'Seed Artist'), song('One', 'Seed Artist'), song('Two', 'Seed Artist'), song('Three', 'Seed Artist'), song('Backup', 'Other Artist')];
  const result = await recommend({ seed: { title: 'Seed', artist: 'Seed Artist' }, limit: 3 }, { candidates: async () => candidates }, { verify: async s => verified(s) }, diagnostics);
  expect(result.recommendations.map(item => item.title)).toEqual(['One', 'Two', 'Backup']);
  expect(diagnostics.rejected.map((item: any) => item.reason)).toEqual(['seed-equivalent', 'artist-diversity']);
});

it.each([
  ['emotionFit', 'weak-emotion-fit'],
  ['energyTempoFit', 'weak-energy-tempo-fit'],
  ['sonicFit', 'weak-sonic-fit'],
  ['themeContextFit', 'weak-theme-context-fit']
] as const)('rejects weak %s before verification and fills from a ranked backup', async (field, reason) => {
  const diagnostics = createDiagnostics();
  const weak = song('Weak', 'Weak Artist', { [field]: 'weak', transitionScore: 99 } as Partial<Record<typeof field, TransitionFit>> & { transitionScore: number });
  const strong = song('Strong', 'Strong Artist', { transitionScore: 90 });
  const acceptable = song('Acceptable', 'Acceptable Artist', { emotionFit: 'acceptable', energyTempoFit: 'acceptable', sonicFit: 'acceptable', themeContextFit: 'acceptable', transitionScore: 70 });
  const verify = vi.fn(async (item: Song) => verified(item));
  const result = await recommend({ seed: { title: 'Seed' }, limit: 2 }, { candidates: async () => [weak, acceptable, strong] }, { verify }, diagnostics);
  expect(result.recommendations.map(item => item.title)).toEqual(['Strong', 'Acceptable']);
  expect(verify.mock.calls.map(call => call[0].title)).toEqual(['Strong', 'Acceptable']);
  expect(diagnostics.rejected).toContainEqual({ song: { title: 'Weak', artist: 'Weak Artist' }, reason, transitionScore: 99 });
});

it('sorts eligible candidates by transition score and keeps Gemini order for ties', async () => {
  const candidates = [song('Tie First', 'A', { transitionScore: 80 }), song('Highest', 'B', { transitionScore: 95 }), song('Tie Second', 'C', { transitionScore: 80 })];
  const result = await recommend({ seed: { title: 'Seed' }, limit: 3 }, { candidates: async () => candidates }, { verify: async item => verified(item) });
  expect(result.recommendations.map(item => item.title)).toEqual(['Highest', 'Tie First', 'Tie Second']);
});
