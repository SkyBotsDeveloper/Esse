import { expect, it, vi } from 'vitest';
import { sameSong, sameUploadSong } from '../src/identity';
import { recommend } from '../src/service';
import { createDiagnostics } from '../src/diagnostics';
import type { RecommendationCandidate, Song } from '../src/types';

const seed = { title: 'Ek Vaari Aa', artist: 'Arijit Singh' };
const assessed = (song: Song): RecommendationCandidate => ({ ...song, emotionFit: 'strong', energyTempoFit: 'strong', sonicFit: 'strong', themeContextFit: 'strong', transitionScore: 80 });
it.each([
  'Ek Vaari Aa', 'Ek Vaari Aa - Official Video', 'Ek Vaari Aa - Official Audio',
  'Ek Vaari Aa Lyrics', 'Ek Vaari Aa (Lyric Video)', 'Ek Vaari Aa | Raabta',
  'Ek Vaari Aa HD', 'Ek Vaari Aa 4K', 'Ek Vaari Aa from Raabta',
  'Ek Vaari Aa (From "Raabta")', 'EK VAARI-AA!', 'Ek Vaari Aa (Acoustic Version)',
  'Ek Vaari Aa - Live', 'Ek Vaari Aa Remix', 'Ek Vaari Aa Reprise',
  'Ek Vaari Aa (Live at Wembley)', 'Arijit Singh - Ek Vaari Aa (Official Audio)',
  'Ek Vaari Aa ft. Guest Singer', 'Ek Vaari Aa [Official Music Video]',
  'Ek Vaari Aa Full Video', 'Ek Vaari Aa Official Audio Arijit Singh'
])('excludes underlying seed identity: %s', async title => {
  const candidate = assessed({ title, artist: 'ARIJIT SINGH' });
  expect(sameSong(seed, candidate)).toBe(true);
  expect(sameSong(candidate, seed)).toBe(true);
  const verify = vi.fn(async () => null);
  const report = createDiagnostics();
  expect((await recommend({ seed, limit: 1 }, { candidates: async () => [candidate] }, { verify }, report)).count).toBe(0);
  expect(verify).not.toHaveBeenCalled();
  expect(report.rejected[0]?.reason).toBe('seed-equivalent');
});
it('normalizes artist credits and Topic suffixes', () => {
  expect(sameSong(seed, { ...seed, artist: 'Arijit Singh - Topic' })).toBe(true);
  expect(sameSong({ title: 'Halo', artist: 'Beyoncé feat. Guest' }, { title: 'HALO', artist: 'Beyonce ft. Guest' })).toBe(true);
  expect(sameSong({ title: "Don't Stop", artist: 'Artist' }, { title: 'Dont Stop', artist: 'Artist' })).toBe(true);
});
it('preserves same generic title by clearly different artists', async () => {
  const candidate = assessed({ title: 'Hello', artist: 'Lionel Richie' });
  const other = { title: 'Hello', artist: 'Adele' };
  expect(sameSong(candidate, other)).toBe(false);
  const result = await recommend({ seed: other, limit: 1 }, { candidates: async () => [candidate] }, {
    verify: async song => ({ ...song, videoId: 'different01' })
  });
  expect(result.recommendations).toEqual([{ title: candidate.title, artist: candidate.artist }]);
});
it.each(['Ek Vaari', 'Ek Vaari Aa Again', 'Ek Vaari Aa - Tomorrow', 'Ek Vaari Aa Tonight'])('preserves genuinely different title %s', title => {
  expect(sameSong(seed, { ...seed, title })).toBe(false);
});
it('does not strip identity words from the middle or beginning of titles', () => {
  expect(sameSong({ title: 'Live Forever', artist: 'Artist' }, { title: 'Forever', artist: 'Artist' })).toBe(false);
  expect(sameSong({ title: 'Love Again', artist: 'Artist' }, { title: 'Love', artist: 'Artist' })).toBe(false);
});
it('is conservative when the seed artist is missing', () => {
  expect(sameSong({ title: 'Hello' }, { title: 'Hello (Official Video)', artist: 'Adele' })).toBe(true);
});
it('uses upload artist evidence to reject a seed mislabeled with its record label', () => {
  expect(sameUploadSong(seed, { title: seed.title, artist: 'Label' }, {
    title: 'Ek Vaari Aa Official Audio', channel: 'Arijit Singh - Topic'
  })).toBe(true);
  expect(sameUploadSong(seed, { title: seed.title, artist: 'Label' }, {
    title: 'Ek Vaari Aa - Official Audio | Arijit Singh', channel: 'Label'
  })).toBe(true);
  expect(sameUploadSong({ title: 'Hello', artist: 'Adele' }, { title: 'Hello', artist: 'Lionel Richie' }, {
    title: 'Hello', channel: 'Lionel Richie - Topic'
  })).toBe(false);
});
it.each(['canonical', 'upload'] as const)('rechecks %s metadata, rejects different video IDs, then fills with a backup', async kind => {
  const alias = assessed({ title: 'Catalog Alias', artist: seed.artist });
  const backup = assessed({ title: 'Different Song', artist: seed.artist });
  const report = createDiagnostics();
  const verify = vi.fn(async (song: Song) => song === alias ? {
    ...song, title: kind === 'canonical' ? 'Ek Vaari Aa (Official Audio)' : song.title,
    videoId: 'newupload01', upload: { title: 'Ek Vaari Aa | Raabta', channel: 'Arijit Singh - Topic' }
  } : { ...song, videoId: 'backup00001' });
  const result = await recommend({ seed, limit: 1 }, { candidates: async () => [assessed({ ...seed, title: 'Ek Vaari Aa Lyrics' }), alias, backup] }, { verify }, report);
  expect(result.recommendations).toEqual([{ title: backup.title, artist: backup.artist }]);
  expect(verify).toHaveBeenCalledTimes(2);
  expect(report.rejected.map(item => item.reason)).toEqual(['seed-equivalent', 'seed-equivalent']);
});
