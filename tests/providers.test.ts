import { afterEach, expect, it, vi } from 'vitest';
import { GEMINI_INSTRUCTION, GeminiProvider, parseCandidates } from '../src/providers/gemini';
import { matchScore } from '../src/providers/youtube';
import { upstreamJson } from '../src/http';
import { CachedVerificationProvider } from '../src/cache';
import { normalize } from '../src/normalize';
import type { Fetcher } from '../src/types';

const song = { title: 'Hawayein', artist: 'Arijit Singh' };
const candidate = { ...song, emotionFit: 'strong', energyTempoFit: 'acceptable', sonicFit: 'strong', themeContextFit: 'acceptable', transitionScore: 88 } as const;
const profile = { primaryMood: 'longing', secondaryMood: 'hopeful', energy: 'low', tempoFeel: 'slow', relationshipTheme: 'romantic longing', sonicCharacter: 'cinematic acoustic', language: 'Hindi', culturalStyle: 'Bollywood', coreTheme: 'longing', subgenre: 'pop ballad', productionStyle: 'cinematic acoustic', eraFeel: 'contemporary' };
const fetchJson = (value: unknown) => vi.fn(async () => Response.json(value)) as unknown as Fetcher;
const envelope = (text: string, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
afterEach(() => vi.useRealTimers());

it.each(['prose', '```json\n{}\n```', '{', '{"candidates": [{"title":"X"}]}', '{"candidates":null}'])('rejects malformed Gemini output: %s', async text => {
  await expect(new GeminiProvider('key', 'configured-model', fetchJson(envelope(text))).candidates({ title: 'Seed' })).rejects.toMatchObject({ status: 502 });
});
it('rejects truncated, oversized, and extra-field Gemini output', async () => {
  await expect(new GeminiProvider('key', 'model', fetchJson(envelope('{"candidates":[]}', 'MAX_TOKENS'))).candidates({ title: 'Seed' })).rejects.toMatchObject({ status: 502 });
  expect(() => parseCandidates({ seedProfile: profile, candidates: Array(21).fill(candidate) })).toThrow();
  expect(() => parseCandidates({ seedProfile: profile, candidates: [{ ...candidate, reason: 'extra' }] })).toThrow();
});
it('uses the configured Gemini model, structured schema and metadata-only input', async () => {
  const mock = fetchJson(envelope(JSON.stringify({ seedProfile: profile, candidates: [candidate] })));
  const provider = new GeminiProvider('secret', 'custom-model', mock);
  expect(await provider.candidates({ title: 'Seed' })).toEqual([candidate]);
  expect(provider.seedProfile).toEqual(profile);
  const [url, init] = vi.mocked(mock).mock.calls[0]!;
  expect(url).toContain('/custom-model:generateContent');
  expect(url).not.toContain('secret');
  const body = JSON.parse(init!.body as string);
  expect(body.generationConfig.responseMimeType).toBe('application/json');
  expect(body.generationConfig.responseJsonSchema.properties.candidates.maxItems).toBe(20);
  expect(body.generationConfig.responseJsonSchema.required).toEqual(['seedProfile', 'candidates']);
  expect(body.generationConfig.responseJsonSchema.properties.seedProfile.required).toEqual([
    'primaryMood', 'secondaryMood', 'energy', 'tempoFeel', 'relationshipTheme', 'sonicCharacter', 'language', 'culturalStyle', 'coreTheme', 'subgenre', 'productionStyle', 'eraFeel'
  ]);
  expect(body.generationConfig.responseJsonSchema.properties.candidates.items.required).toEqual([
    'title', 'artist', 'emotionFit', 'energyTempoFit', 'sonicFit', 'themeContextFit', 'transitionScore'
  ]);
  expect(body.generationConfig.responseJsonSchema.properties.candidates.items.properties.sonicFit.enum).toEqual(['strong', 'acceptable', 'weak']);
  expect(body.generationConfig.responseJsonSchema.properties.candidates.items.properties.transitionScore).toMatchObject({ type: 'integer', minimum: 0, maximum: 100 });
  expect(body.generationConfig).not.toHaveProperty('responseFormat');
  expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  expect(body.generationConfig).not.toHaveProperty('temperature');
  expect(body.generationConfig).not.toHaveProperty('topP');
  expect(body.generationConfig).not.toHaveProperty('topK');
  expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({ title: 'Seed' });
});
it.each([
  { candidates: [candidate] },
  { seedProfile: { ...profile, energy: '' }, candidates: [candidate] },
  { seedProfile: { ...profile, language: undefined }, candidates: [candidate] },
  { seedProfile: { ...profile, culturalStyle: undefined }, candidates: [candidate] },
  { seedProfile: { ...profile, coreTheme: undefined }, candidates: [candidate] },
  { seedProfile: { ...profile, subgenre: undefined }, candidates: [candidate] },
  { seedProfile: { ...profile, productionStyle: '' }, candidates: [candidate] },
  { seedProfile: { ...profile, eraFeel: undefined }, candidates: [candidate] },
  { seedProfile: { ...profile, explanation: 'private reasoning' }, candidates: [candidate] }
])('rejects malformed seed profiles safely', async value => {
  await expect(new GeminiProvider('key', 'model', fetchJson(envelope(JSON.stringify(value)))).candidates({ title: 'Seed' })).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' });
});
it('keeps all existing profile fields and validates the three sonic fields', () => {
  expect(Object.keys(profile).sort()).toEqual([
    'coreTheme', 'culturalStyle', 'energy', 'eraFeel', 'language', 'primaryMood', 'productionStyle', 'relationshipTheme', 'secondaryMood', 'sonicCharacter', 'subgenre', 'tempoFeel'
  ]);
  expect(parseCandidates({ seedProfile: profile, candidates: [candidate] })).toEqual([candidate]);
});
it.each([
  { ...candidate, sonicFit: 'great' },
  { ...candidate, emotionFit: undefined },
  { ...candidate, transitionScore: -1 },
  { ...candidate, transitionScore: 101 },
  { ...candidate, transitionScore: 88.5 }
])('rejects malformed transition assessments safely', value => {
  expect(() => parseCandidates({ seedProfile: profile, candidates: [value] })).toThrow();
});
it('makes specific sonic production stronger than broad labels while allowing adjacent genres', () => {
  const prompt = GEMINI_INSTRUCTION.toLowerCase();
  expect(prompt).toContain('sonic/subgenre and production compatibility are stronger evidence than broad genre labels');
  for (const broad of ['"pop"', '"sad"', '"energetic"', '"confident"']) expect(prompt).toContain(broad);
  expect(prompt).toContain('are each too broad to establish similarity by themselves');
  expect(prompt).toContain('adjacent genres remain welcome when transition-compatible');
  for (const gate of ['emotionfit', 'energytempofit', 'sonicfit', 'themecontextfit']) expect(prompt).toContain(gate);
  expect(prompt).toContain('never output explanations or chain-of-thought');
});
it('accepts a non-relationship seed profile without forcing romance', async () => {
  const nonRelationship = { ...profile, relationshipTheme: 'none/not-applicable', coreTheme: 'travel and self-discovery' };
  const provider = new GeminiProvider('key', 'model', fetchJson(envelope(JSON.stringify({ seedProfile: nonRelationship, candidates: [candidate] }))));
  await expect(provider.candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
  expect(provider.seedProfile).toEqual(nonRelationship);
});
it.each(['Cover', 'Karaoke', 'Slowed Reverb', 'Nightcore', 'Remix', 'Fan Edit', 'Reaction', 'Tutorial', 'Sped Up', 'Live'])('rejects unwanted %s', variant => {
  expect(matchScore(song, { id: 'abcdefghijk', title: `Hawayein Arijit Singh Official Audio ${variant}`, channel: 'Sony Music India' })).toBe(0);
});
it('rejects unrelated, partial-title, and untrusted uploads even if labeled official', () => {
  for (const video of [
    { title: 'Other Song Arijit Singh', channel: 'Arijit Singh - Topic' },
    { title: 'Hawayein Other Artist Official Audio', channel: 'Sony Music India' },
    { title: 'Hawayein Arijit Singh Official Audio', channel: 'Random Fan' },
    { title: 'Hawayein Extendedword', channel: 'Unrelated Artist' }
  ]) expect(matchScore(song, { ...video, id: 'abcdefghijk' })).toBe(0);
  expect(matchScore({ title: 'Love', artist: 'Artist' }, { title: 'Lovely', channel: 'Artist - Topic', id: 'abcdefghijk' })).toBe(0);
  expect(matchScore({ title: 'Love', artist: 'Artist' }, { title: 'Love Again', channel: 'Artist - Topic', id: 'abcdefghijk' })).toBe(0);
});
it('permits an explicitly requested version', () => {
  expect(matchScore({ ...song, title: 'Hawayein Remix' }, { id: 'abcdefghijk', title: 'Hawayein Remix Arijit Singh', channel: 'Sony Music India' })).toBeGreaterThanOrEqual(75);
});
it('preserves conservative one-edit title matching', () => {
  expect(matchScore(song, { id: 'abcdefghijk', title: 'Hawaayein', channel: 'Arijit Singh - Topic' })).toBeGreaterThanOrEqual(75);
});
it.each([403, 429, 500, 401])('sanitizes upstream HTTP %s errors', async status => {
  const mock = vi.fn(async () => new Response('secret provider details', { status })) as unknown as Fetcher;
  await expect(upstreamJson(mock, 'YouTube', 'https://example.com', {}, 100)).rejects.toMatchObject({ status: status === 403 || status === 429 ? 503 : 502 });
});
it('times out stalled upstream requests', async () => {
  vi.useFakeTimers();
  const mock = vi.fn((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('secret'))))) as unknown as Fetcher;
  const result = expect(upstreamJson(mock, 'Gemini', 'https://example.com', {}, 100)).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(100);
  await result;
});
it('uses cached verification and tolerates cache failure without hiding provider errors', async () => {
  const value = { ...song, videoId: 'abcdefghijk' };
  const provider = { verify: vi.fn(async () => value) };
  const cache = { get: vi.fn(async () => value), put: vi.fn(async () => {}) };
  expect(await new CachedVerificationProvider(provider, cache).verify(song)).toEqual(value);
  expect(provider.verify).not.toHaveBeenCalled();
  cache.get.mockRejectedValue(new Error('cache down'));
  cache.put.mockRejectedValue(new Error('cache down'));
  expect(await new CachedVerificationProvider(provider, cache).verify(song)).toEqual(value);
  provider.verify.mockRejectedValue(new Error('upstream down'));
  await expect(new CachedVerificationProvider(provider, cache).verify(song)).rejects.toThrow('upstream down');
});
it('normalizes Latin accents without destroying Indic vowel marks', () => {
  expect(normalize('Beyoncé!')).toBe('beyonce');
  expect(normalize('दिन')).not.toBe(normalize('दुन'));
});
