import { afterEach, expect, it, vi } from 'vitest';
import searchFixture from './fixtures/innertube/search.json';
import officialFixture from './fixtures/innertube/official-rich.json';
import emptyFixture from './fixtures/innertube/empty.json';
import changedFixture from './fixtures/innertube/changed.json';
import metadataFixture from './fixtures/innertube/metadata-realities.json';
import versionContextFixture from './fixtures/innertube/version-context.json';
import { INNERTUBE, parseSearch } from '../src/providers/innertube';
import { YouTubeProvider } from '../src/providers/youtube';
import { recommend } from '../src/service';
import { createDiagnostics } from '../src/diagnostics';
import { handleRequest } from '../src/index';
import type { Fetcher } from '../src/types';

const song = { title: 'Hawayein', artist: 'Arijit Singh' };
const assessed = <T extends { title: string; artist: string }>(value: T) => ({ ...value, emotionFit: 'strong' as const, energyTempoFit: 'strong' as const, sonicFit: 'strong' as const, themeContextFit: 'strong' as const, transitionScore: 80 });
const profile = { primaryMood: 'longing', secondaryMood: 'hopeful', energy: 'low', tempoFeel: 'slow', relationshipTheme: 'romantic longing', sonicCharacter: 'cinematic acoustic', language: 'Hindi', culturalStyle: 'Bollywood', coreTheme: 'longing', subgenre: 'pop ballad', productionStyle: 'cinematic acoustic', eraFeel: 'contemporary' };
const fetchJson = (value: unknown) => vi.fn(async () => Response.json(value)) as unknown as Fetcher;
const singleResult = (index: number) => {
  const copy = structuredClone(searchFixture);
  const sections = copy.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
  const section = sections[0]!.itemSectionRenderer!;
  section.contents = [section.contents[index]!];
  return copy;
};
const metadataResult = (index: number) => {
  const copy = structuredClone(metadataFixture);
  const section = copy.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0]!.itemSectionRenderer!;
  section.contents = [section.contents[index]!];
  return copy;
};
const versionContextResult = (index: number) => {
  const copy = structuredClone(versionContextFixture);
  const section = copy.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0]!.itemSectionRenderer!;
  section.contents = [section.contents[index]!];
  return copy;
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('accepts a correct Topic song after multiple rejected results with a keyless POST', async () => {
  const mock = fetchJson(searchFixture);
  expect(await new YouTubeProvider(mock).verify(song)).toEqual({ ...song, videoId: 'topic000001', upload: { title: 'Hawayein', channel: 'Arijit Singh - Topic' } });
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = vi.mocked(mock).mock.calls[0]!;
  expect(url).toBe(INNERTUBE.endpoint);
  expect(String(url)).not.toContain('key=');
  expect(init!.method).toBe('POST');
  expect(JSON.parse(init!.body as string)).toEqual({ context: { client: INNERTUBE.client }, query: 'Hawayein Arijit Singh', params: INNERTUBE.videoFilter });
  expect(new Headers(init!.headers).has('x-goog-api-key')).toBe(false);
});
it.each([[1, 'unrelated'], [2, 'cover'], [3, 'karaoke'], [4, 'slowed/reverb']] as const)('rejects fixture result %s (%s)', async (index, _kind) => {
  expect(await new YouTubeProvider(fetchJson(singleResult(index))).verify(song)).toBeNull();
});
it('accepts a label official-style upload inside a rich-grid wrapper', async () => {
  expect(await new YouTubeProvider(fetchJson(officialFixture)).verify(song)).toEqual({ ...song, videoId: 'official001', upload: { title: 'Hawayein - Official Music Video | Arijit Singh', channel: 'Sony Music India' } });
});
it.each([
  [0, { title: 'Kabira', artist: 'Tochi Raina' }, 'soundtrk001'],
  [1, { title: 'Agar Tum Saath Ho', artist: 'Alka Yagnik' }, 'multising01'],
  [2, { title: 'Jeena Jeena', artist: 'Atif Aslam' }, 'labelvid001'],
  [3, { title: 'Soch', artist: 'Hardy Sandhu' }, 'topicvar001'],
  [4, { title: 'Qismat', artist: 'Ammy Virk' }, 'promovid001']
] as const)('accepts decorated, multi-artist, label, Topic, and conservative spelling case %s', async (index, requested, id) => {
  await expect(new YouTubeProvider(fetchJson(metadataResult(index))).verify(requested)).resolves.toMatchObject({ ...requested, videoId: id });
});
it.each([[6, 'cover'], [7, 'karaoke'], [8, 'slowed/reverb']] as const)('still rejects metadata fixture %s (%s)', async (index, _kind) => {
  const provider = new YouTubeProvider(fetchJson(metadataResult(index)));
  await expect(provider.verify({ title: 'Kabira', artist: 'Tochi Raina' })).resolves.toBeNull();
  expect(provider.lastFailureReason).toBe('unwanted version');
});
it.each([
  [0, 'official video'], [1, 'official music video'], [2, 'official audio'], [3, 'soundtrack'],
  [4, 'label promotion'], [5, 'marker-like substring'], [6, 'ambiguous version decoration'], [7, 'lyric video'], [20, 'channel decoration']
] as const)('accepts context fixture %s (%s)', async (index, _kind) => {
  await expect(new YouTubeProvider(fetchJson(versionContextResult(index))).verify({ title: 'Signal', artist: 'Olive Band' })).resolves.toMatchObject({ title: 'Signal', artist: 'Olive Band' });
});
it.each([
  [8, 'cover', 'cover'], [9, 'karaoke', 'karaoke'], [10, 'slowed', 'slowed'], [11, 'slowed + reverb', 'slowed + reverb'],
  [12, 'sped up', 'sped up'], [13, 'nightcore', 'nightcore'], [14, 'reaction', 'reaction'], [15, 'tutorial', 'tutorial'],
  [16, 'fan edit', 'fan edit'], [17, 'remix', 'remix'], [18, 'live version', 'live'], [19, 'instrumental', 'instrumental']
] as const)('rejects explicit context fixture %s (%s) with its marker', async (index, _kind, marker) => {
  const provider = new YouTubeProvider(fetchJson(versionContextResult(index)));
  await expect(provider.verify({ title: 'Signal', artist: 'Olive Band' })).resolves.toBeNull();
  expect(provider.lastFailureReason).toBe('unwanted version');
  expect(provider.lastFailureDetail).toBe(`marker="${marker}"`);
});
it('propagates the detected marker into evaluation-only rejection diagnostics', async () => {
  const diagnostics = createDiagnostics();
  await recommend({ seed: { title: 'Other' }, limit: 1 }, { candidates: async () => [assessed({ title: 'Signal', artist: 'Olive Band' })] }, new YouTubeProvider(fetchJson(versionContextResult(11))), diagnostics);
  expect(diagnostics.rejected[0]).toMatchObject({ reason: 'unverified', detail: 'unwanted version: marker="slowed + reverb"' });
});
it('reports the strongest failed match instead of an incidental unwanted result', async () => {
  const fixture = structuredClone(versionContextFixture);
  const section = fixture.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0]!.itemSectionRenderer!;
  section.contents = [
    { videoRenderer: { videoId: 'lowconf0002', title: { simpleText: 'Signal Fire by Olive Band' }, ownerText: { simpleText: 'Random Upload' } } },
    { videoRenderer: { videoId: 'othercover1', title: { simpleText: 'Signal Fire Cover | Other Artist' }, ownerText: { simpleText: 'Other Artist - Topic' } } }
  ];
  const provider = new YouTubeProvider(fetchJson(fixture));
  await expect(provider.verify({ title: 'Signal Fire', artist: 'Olive Band' })).resolves.toBeNull();
  expect(provider.lastFailureReason).toBe('low confidence');
  expect(provider.lastFailureDetail).toBeUndefined();
});
it('rejects a wrong song by the requested artist and reports title mismatch', async () => {
  const provider = new YouTubeProvider(fetchJson(metadataResult(5)));
  await expect(provider.verify(song)).resolves.toBeNull();
  expect(provider.lastFailureReason).toBe('no strong title match');
});
it('keeps low-confidence uploads rejected with a compact internal reason', async () => {
  const provider = new YouTubeProvider(fetchJson(metadataResult(9)));
  await expect(provider.verify({ title: 'Agar Tum Saath Ho', artist: 'Alka Yagnik' })).resolves.toBeNull();
  expect(provider.lastFailureReason).toBe('low confidence');
});
it('distinguishes an explicit empty search from a broken parser', async () => {
  expect(await new YouTubeProvider(fetchJson(emptyFixture)).verify(song)).toBeNull();
});
it.each([{}, { error: { code: 403 } }, changedFixture,
  { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [] } } } } }
])('fails safely on unsupported or malformed response %j', async fixture => {
  await expect(new YouTubeProvider(fetchJson(fixture)).verify(song)).rejects.toMatchObject({ status: 502, code: 'INVALID_UPSTREAM_RESPONSE' });
});
it('does not accept a valid match when another video renderer has lost required metadata', async () => {
  const fixture = structuredClone(searchFixture);
  delete (fixture.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0]!.itemSectionRenderer!.contents[1]!.videoRenderer as { title?: unknown }).title;
  await expect(new YouTubeProvider(fetchJson(fixture)).verify(song)).rejects.toMatchObject({ status: 502 });
});
it('bounds parser work rather than recursively scanning arbitrary response objects', () => {
  const fixture = structuredClone(searchFixture);
  const section = fixture.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0]!.itemSectionRenderer!;
  section.contents = Array(201).fill(section.contents[1]);
  expect(() => parseSearch(fixture)).toThrow();
});
it('fills requested results from backups through the actual fixture-backed provider', async () => {
  const mock = vi.fn()
    .mockResolvedValueOnce(Response.json(singleResult(2)))
    .mockResolvedValueOnce(Response.json(searchFixture))
    .mockResolvedValueOnce(Response.json(officialFixture));
  const result = await recommend({ seed: { title: 'Seed' }, limit: 1 }, {
    candidates: async () => [assessed({ title: 'Unverifiable', artist: song.artist }), assessed(song), assessed({ title: 'Unused', artist: song.artist })]
  }, new YouTubeProvider(mock as Fetcher));
  expect(result.recommendations).toEqual([song]);
  expect(mock).toHaveBeenCalledTimes(2);
});
it('production wiring needs only Gemini configuration and still verifies via Innertube', async () => {
  const mock = vi.fn()
    .mockResolvedValueOnce(Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ seedProfile: profile, candidates: [assessed(song)] }) }] } }] }))
    .mockResolvedValueOnce(Response.json(searchFixture));
  vi.stubGlobal('fetch', mock);
  const response = await handleRequest(new Request('https://esse.test/v1/recommend', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-client-secret' }, body: JSON.stringify({ song: 'Seed', limit: 1 })
  }), { ESSE_API_KEYS: 'fixture-client-secret', GEMINI_API_KEY: 'test-only', GEMINI_MODEL: 'test-model', RECOMMEND_RATE_LIMITER: { limit: async () => ({ success: true }) }, RECOMMEND_GENERATION_RATE_LIMITER: { limit: async () => ({ success: true }) } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ count: 1, recommendations: [song] });
  expect(mock).toHaveBeenCalledTimes(2);
});
it('retains the YouTube timeout', async () => {
  vi.useFakeTimers();
  const mock = vi.fn((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as Fetcher;
  const check = expect(new YouTubeProvider(mock).verify(song)).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(INNERTUBE.timeoutMs);
  await check;
});
