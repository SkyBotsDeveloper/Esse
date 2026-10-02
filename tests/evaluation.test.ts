import { expect, it, vi } from 'vitest';
import { evaluate } from '../src/evaluation';
import { WorkerVerificationCache } from '../src/cache';
import type { RecommendationCandidate, Song, VerifiedSong } from '../src/types';

const seed = { title: 'Seed', artist: 'Artist' };
const assessed = (song: Song, transitionScore = 80): RecommendationCandidate => ({ ...song, emotionFit: 'strong', energyTempoFit: 'strong', sonicFit: 'strong', themeContextFit: 'strong', transitionScore });
it('reports real pipeline counts, backups and cache reuse without leaking internal metadata', async () => {
  const stored = new Map<string, VerifiedSong>();
  const cache = { get: async (song: Song) => stored.get(song.title), put: async (song: Song, value: VerifiedSong) => { stored.set(song.title, value); } };
  const brain = { seedProfile: { primaryMood: 'longing', secondaryMood: 'hopeful', energy: 'low', tempoFeel: 'slow', relationshipTheme: 'romantic longing', sonicCharacter: 'acoustic', language: 'Hindi', culturalStyle: 'Bollywood', coreTheme: 'longing', subgenre: 'pop ballad', productionStyle: 'cinematic acoustic', eraFeel: 'contemporary' }, candidates: async () => [
    assessed({ ...seed, title: 'Seed Official Audio' }), assessed({ title: 'Invalid', artist: 'Artist' }),
    assessed({ title: 'Backup', artist: 'Artist' }), assessed({ title: 'Unused', artist: 'Artist' })
  ] };
  const verify = vi.fn(async (song: Song) => song.title === 'Invalid' ? null : { ...song, videoId: 'fixture0001', upload: { title: song.title, channel: 'Artist - Topic' } });
  const report = await evaluate({ seed, limit: 1 }, brain, { verify }, cache);
  expect(report.recommendations).toEqual([{ title: 'Backup', artist: 'Artist' }]);
  expect(report.diagnostics).toMatchObject({ candidateCount: 4, verificationAttempts: 2 });
  expect(report.seedEquivalentRejected).toBe(1);
  expect(report.artistDiversityRejected).toBe(0);
  expect(report.seedProfile).toEqual(brain.seedProfile);
  expect(report.youtubeChecks).toBe(2);
  expect(report.cache).toEqual({ hits: 0, misses: 2 });
  expect(report.diagnostics.rejected.map(item => item.reason)).toEqual(['seed-equivalent', 'unverified']);
  expect(report.diagnostics.totalMs).toBeGreaterThanOrEqual(report.youtubeMs);
  const cached = await evaluate({ seed, limit: 1 }, brain, { verify }, cache);
  expect(cached.cache).toEqual({ hits: 1, misses: 1 });
  expect(cached.youtubeChecks).toBe(1);
  expect(JSON.stringify(report)).not.toContain('videoId');
});
it('sanitizes failures and never presents partially accepted songs as final output', async () => {
  const report = await evaluate({ seed, limit: 2 }, { candidates: async () => [assessed({ title: 'One', artist: 'Artist' }), assessed({ title: 'Two', artist: 'Artist' })] }, {
    verify: async song => { if (song.title === 'Two') throw new Error('secret credential'); return { ...song, videoId: 'fixture0001' }; }
  }, { get: async () => undefined, put: async () => {} });
  expect(report.error).toBe('Evaluation failed.');
  expect(report.recommendations).toEqual([]);
  expect(report.diagnostics.accepted.length).toBe(1);
  expect(JSON.stringify(report)).not.toContain('secret');
});
it('reports a compact verifier failure reason only in evaluation diagnostics', async () => {
  const verifier = { lastFailureReason: 'artist mismatch' as const, verify: async () => null };
  const report = await evaluate({ seed, limit: 1 }, { candidates: async () => [assessed({ title: 'Candidate', artist: 'Other' })] }, verifier, { get: async () => undefined, put: async () => {} });
  expect(report.diagnostics.rejected).toEqual([{ song: { title: 'Candidate', artist: 'Other' }, reason: 'unverified', detail: 'artist mismatch', transitionScore: 80 }]);
});
it('bypasses the final Worker result cache during evaluation', async () => {
  const match = vi.fn();
  vi.stubGlobal('caches', { default: { match } });
  try {
    const report = await evaluate({ seed, limit: 1 }, { candidates: async () => [assessed({ title: 'Next', artist: 'Other' })] }, { verify: async song => ({ ...song, videoId: 'fixture0001' }) }, { get: async () => undefined, put: async () => {} });
    expect(report.recommendations).toHaveLength(1);
    expect(match).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
it('retains upload identity across the Worker cache boundary', async () => {
  let saved: Response | undefined;
  const cache = new WorkerVerificationCache({
    match: vi.fn(async () => saved?.clone()),
    put: vi.fn(async (_key: Request, response: Response) => { saved = response; })
  } as unknown as Cache, 'https://esse.test');
  const song = { title: 'Alias', artist: 'Artist' };
  const value = { ...song, videoId: 'fixture0001', upload: { title: 'Seed - Official Audio', channel: 'Artist - Topic' } };
  await cache.put(song, value);
  expect(await cache.get(song)).toEqual(value);
  saved = Response.json({ ...song, videoId: 'fixture0001' });
  expect(await cache.get(song)).toBeUndefined();
});
