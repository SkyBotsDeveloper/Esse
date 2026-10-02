import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import { ELITE_FORMAT_CONTRACT, ELITE_INSTRUCTION, ELITE_RECOMMENDATION_TOOL, ELITE_TOOL_INSTRUCTION, ELITE_TOOL_NAME, EliteGeminiProvider, EliteProvider, eliteHealth, resetEliteHealth } from '../src/providers/elite';
import { GEMINI_INSTRUCTION } from '../src/providers/gemini';
import { MAX_CANDIDATES, RECOMMENDATION_CANDIDATE_FIELDS, RECOMMENDATION_OUTPUT_FIELDS, RECOMMENDATION_PROFILE_FIELDS, TRANSITION_FIT_VALUES, type Fetcher, type RecommendationCandidate, type SeedProfile } from '../src/types';

const profile: SeedProfile = { primaryMood: 'warm', secondaryMood: 'hopeful', energy: 'moderate', tempoFeel: 'mid-tempo', relationshipTheme: 'romantic', sonicCharacter: 'polished pop', language: 'Hindi', culturalStyle: 'Bollywood', coreTheme: 'romance', subgenre: 'pop', productionStyle: 'cinematic', eraFeel: 'current' };
const candidate: RecommendationCandidate = { title: 'Next', artist: 'Artist', emotionFit: 'strong', energyTempoFit: 'acceptable', sonicFit: 'strong', themeContextFit: 'acceptable', transitionScore: 87 };
const output = { seedProfile: profile, candidates: [candidate] };
const completion = (content: string) => ({ choices: [{ message: { content } }] });
const toolCompletion = (argumentsValue: unknown, name = ELITE_TOOL_NAME) => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: typeof argumentsValue === 'string' ? argumentsValue : JSON.stringify(argumentsValue) } }] } }] });
const fetchJson = (value: unknown, status = 200, headers?: HeadersInit) => vi.fn(async () => Response.json(value, { status, headers })) as unknown as Fetcher;
const make = (fetcher: Fetcher, observer = vi.fn()) => ({ provider: new EliteProvider('secret-elite-key', 'gpt-5.6-luna', 'https://elite.test/v1', fetcher, observer), observer });
beforeEach(() => resetEliteHealth());
afterEach(() => vi.useRealTimers());

it('sends one native non-streaming OpenAI-compatible request with the shared ESSE prompt', async () => {
  const mock = fetchJson(completion(JSON.stringify(output)));
  const { provider, observer } = make(mock);
  expect(await provider.candidates({ title: 'Seed', artist: 'Singer' })).toEqual([candidate]);
  const [url, init] = vi.mocked(mock).mock.calls[0]!;
  expect(url).toBe('https://elite.test/v1/chat/completions');
  expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-elite-key', 'content-type': 'application/json' });
  const body = JSON.parse(init?.body as string);
  expect(body).toMatchObject({ model: 'gpt-5.6-luna', stream: false, max_tokens: 4096 });
  expect(body).not.toHaveProperty('response_format');
  expect(body.messages).toEqual([{ role: 'system', content: ELITE_INSTRUCTION }, { role: 'user', content: JSON.stringify({ title: 'Seed', artist: 'Singer' }) }]);
  expect(body.messages[0].content).toContain('Field names are an API contract and must not be renamed, expanded, or replaced with synonyms.');
  expect(body.messages[0].content).toContain('seedProfile keys exactly: primaryMood, secondaryMood, energy, tempoFeel, relationshipTheme, sonicCharacter, language, culturalStyle, coreTheme, subgenre, productionStyle, eraFeel.');
  expect(body.messages[0].content).toContain('Each candidate keys exactly: title, artist, emotionFit, energyTempoFit, sonicFit, themeContextFit, transitionScore.');
  expect(body.messages[0].content).toContain('Rank transition quality using the gates above');
  expect(body.messages[0].content).not.toContain('Avoid popularity-only choices, broad-genre shortcuts, famous mood-breaking tracks, and seed-artist bias.');
  expect(ELITE_FORMAT_CONTRACT.length).toBeLessThan(600);
  expect(provider.seedProfile).toEqual(profile);
  expect(observer).toHaveBeenCalledWith(expect.objectContaining({ requestBytes: new TextEncoder().encode(init?.body as string).byteLength }));
});

it('accepts direct JSON and one standard fenced JSON wrapper', async () => {
  for (const content of [JSON.stringify(output), `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``]) {
    const { provider } = make(fetchJson(completion(content)));
    await expect(provider.candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
  }
});

it.each(['Here is the result: {}', '{', '```json\n{}\n```'])('rejects prose, invalid JSON or schema-invalid output without salvage', async content => {
  const { provider } = make(fetchJson(completion(content)));
  await expect(provider.candidates({ title: 'Seed' })).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' });
});

it.each([{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: null } }] }])('rejects malformed completion envelope %j', async envelope => {
  const { provider } = make(fetchJson(envelope));
  await expect(provider.candidates({ title: 'Seed' })).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' });
});

it('never logs credentials or request content in provider diagnostics', async () => {
  const { provider, observer } = make(fetchJson(completion(JSON.stringify(output))));
  await provider.candidates({ title: 'private seed' });
  const text = JSON.stringify(observer.mock.calls);
  expect(text).not.toContain('secret-elite-key');
  expect(text).not.toContain('private seed');
  expect(observer).toHaveBeenCalledWith(expect.objectContaining({ provider: 'elite', model: 'gpt-5.6-luna', outcome: 'success' }));
});

it('times out within the configured attempt budget and marks transient health', async () => {
  vi.useFakeTimers();
  const mock = vi.fn((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('network'))))) as unknown as Fetcher;
  const { provider, observer } = make(mock);
  const result = expect(provider.candidates({ title: 'Seed' })).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(6000);
  await result;
  expect(eliteHealth()).toMatchObject({ type: 'timeout' });
  expect(observer).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'timeout', latencyMs: 6000 }));
});

it.each([401, 403, 429, 503])('records one failure attempt for HTTP %s and applies expected health behavior', async status => {
  const { provider, observer } = make(fetchJson({ error: 'private detail' }, status, status === 429 ? { 'retry-after': '20' } : undefined));
  await expect(provider.candidates({ title: 'Seed' })).rejects.toBeInstanceOf(AppError);
  expect(observer).toHaveBeenCalledOnce();
  expect(observer).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: status, outcome: 'http-error' }));
  expect(status === 401 || status === 403 || status === 429 || status === 503 ? eliteHealth() : undefined).toBeDefined();
  if (status === 429) expect(eliteHealth()?.cooldownUntil).toBeGreaterThanOrEqual(Date.now() + 19_900);
  expect(JSON.stringify(observer.mock.calls)).not.toContain('private detail');
});

it('uses Gemini after Elite failure, skips Elite during cooldown and clears health on success', async () => {
  const failed = make(fetchJson({}, 503)).provider;
  const gemini = { seedProfile: profile, candidates: vi.fn(async () => [candidate]) };
  const order: string[] = [];
  const brain = new EliteGeminiProvider(failed, gemini, event => order.push(event.outcome));
  await expect(brain.candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
  expect(gemini.candidates).toHaveBeenCalledOnce();
  expect(order).toEqual([]);
  const cooldownBrain = new EliteGeminiProvider(failed, gemini, event => order.push(event.outcome));
  await cooldownBrain.candidates({ title: 'Seed' });
  expect(order).toEqual(['cooldown-skip']);

  const healthy = make(fetchJson(completion(JSON.stringify(output)))).provider;
  await healthy.candidates({ title: 'Seed' });
  expect(eliteHealth()).toBeUndefined();
});

it('does not attempt Gemini after a valid Elite response', async () => {
  const elite = make(fetchJson(completion(JSON.stringify(output)))).provider;
  const gemini = { candidates: vi.fn(async () => [candidate]) };
  const brain = new EliteGeminiProvider(elite, gemini);
  await expect(brain.candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
  expect(gemini.candidates).not.toHaveBeenCalled();
});

it('uses Gemini once after Elite 401/403 without retrying Elite', async () => {
  for (const status of [401, 403]) {
    resetEliteHealth();
    const mock = fetchJson({}, status);
    const elite = make(mock).provider;
    const gemini = { candidates: vi.fn(async () => [candidate]) };
    await expect(new EliteGeminiProvider(elite, gemini).candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
    expect(vi.mocked(mock)).toHaveBeenCalledOnce();
    expect(gemini.candidates).toHaveBeenCalledOnce();
  }
});

it.each([429, 500, 502, 503, 504])('falls back from transient Elite HTTP %s to Gemini without an Elite retry', async status => {
  resetEliteHealth();
  const mock = fetchJson({}, status);
  const elite = make(mock).provider;
  const gemini = { candidates: vi.fn(async () => [candidate]) };
  await expect(new EliteGeminiProvider(elite, gemini).candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
  expect(vi.mocked(mock)).toHaveBeenCalledOnce();
  expect(gemini.candidates).toHaveBeenCalledOnce();
});

it('falls back from schema-invalid Elite output without accepting partial candidates', async () => {
  resetEliteHealth();
  const elite = make(fetchJson(completion(JSON.stringify({ candidates: [candidate] })))).provider;
  const gemini = { candidates: vi.fn(async () => [candidate]) };
  await expect(new EliteGeminiProvider(elite, gemini).candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
  expect(gemini.candidates).toHaveBeenCalledOnce();
});

it('inspects envelope, content format and exact schema rejection without printing secrets or prompt', async () => {
  const inspections: unknown[] = [];
  const mock = fetchJson(completion(JSON.stringify({ seedProfile: profile, candidates: [{ ...candidate, sonicFit: 'invalid' }] })));
  const provider = new EliteProvider('diagnostic-secret', 'gpt-5.6-luna', 'https://elite.test/v1', mock, undefined, 15000, value => inspections.push(value));
  await expect(provider.candidates({ title: 'Private seed', artist: 'Private artist' })).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' });
  expect(inspections[0]).toMatchObject({
    httpStatus: 200, topLevelKeys: ['choices'], choicesExists: true, choicesType: 'array', choicesLength: 1,
    firstChoiceKeys: ['message'], messageExists: true, messageKeys: ['content'], contentType: 'string',
    contentFormat: 'direct JSON', rejectionStage: 'ESSE recommendation schema validation', schemaError: 'candidates[0].sonicFit enum'
  });
  const serialized = JSON.stringify(inspections);
  expect(serialized).not.toContain('diagnostic-secret');
  expect(serialized).not.toContain('Private seed');
  expect(serialized).not.toContain(GEMINI_INSTRUCTION);
  expect((inspections[0] as { sanitizedPreview: string }).sanitizedPreview.length).toBeLessThanOrEqual(1500);
});

it('propagates a safe failure when both providers fail', async () => {
  const elite = make(fetchJson({}, 503)).provider;
  const gemini = { candidates: vi.fn(async () => { throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'safe'); }) };
  await expect(new EliteGeminiProvider(elite, gemini).candidates({ title: 'Seed' })).rejects.toMatchObject({ status: 503 });
});

it('generates a function schema directly from canonical ESSE fields and bounds', () => {
  const schema = ELITE_RECOMMENDATION_TOOL.function.parameters;
  expect(ELITE_RECOMMENDATION_TOOL.function.name).toBe('submit_esse_recommendations');
  expect(schema.required).toEqual(RECOMMENDATION_OUTPUT_FIELDS);
  expect(Object.keys(schema.properties.seedProfile.properties)).toEqual(RECOMMENDATION_PROFILE_FIELDS);
  expect(schema.properties.seedProfile.required).toEqual(RECOMMENDATION_PROFILE_FIELDS);
  expect(Object.keys(schema.properties.candidates.items.properties)).toEqual(RECOMMENDATION_CANDIDATE_FIELDS);
  expect(schema.properties.candidates.items.required).toEqual(RECOMMENDATION_CANDIDATE_FIELDS);
  expect(schema.properties.candidates.maxItems).toBe(MAX_CANDIDATES);
  expect(schema.properties.candidates.items.properties.emotionFit.enum).toEqual(TRANSITION_FIT_VALUES);
  expect(schema.properties.candidates.items.properties.energyTempoFit.enum).toEqual(TRANSITION_FIT_VALUES);
  expect(schema.properties.candidates.items.properties.sonicFit.enum).toEqual(TRANSITION_FIT_VALUES);
  expect(schema.properties.candidates.items.properties.themeContextFit.enum).toEqual(TRANSITION_FIT_VALUES);
  expect(schema.properties.candidates.items.properties.transitionScore).toEqual({ type: 'integer', minimum: 0, maximum: 100 });
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.seedProfile.additionalProperties).toBe(false);
  expect(schema.properties.candidates.items.additionalProperties).toBe(false);
});

it('uses one forced structured tool for mistral-small-4 and validates its arguments with the canonical validator', async () => {
  const mock = fetchJson(toolCompletion(output));
  const observer = vi.fn();
  const inspections: unknown[] = [];
  const provider = new EliteProvider('secret-elite-key', 'mistral-small-4', 'https://elite.test/v1', mock, observer, 15000, event => inspections.push(event));
  await expect(provider.candidates({ title: 'Seed', artist: 'Singer' })).resolves.toEqual([candidate]);
  expect(provider.seedProfile).toEqual(profile);
  const [, init] = vi.mocked(mock).mock.calls[0]!;
  const body = JSON.parse(init?.body as string);
  expect(body.stream).toBe(false);
  expect(body.tools).toEqual([ELITE_RECOMMENDATION_TOOL]);
  expect(body.tool_choice).toEqual({ type: 'function', function: { name: ELITE_TOOL_NAME } });
  expect(body.messages[0].content).toBe(ELITE_TOOL_INSTRUCTION);
  expect(body.messages[0].content).toContain('Rank transition quality using the gates above');
  expect(body.messages[0].content).not.toContain('Return exactly one JSON object');
  expect(inspections[0]).toMatchObject({ outputMode: 'tool-call', toolCallsExists: true, toolCallsLength: 1, functionName: ELITE_TOOL_NAME, argumentType: 'string', argumentsParsed: true });
  const diagnosticText = JSON.stringify([observer.mock.calls, inspections]);
  expect(diagnosticText).not.toContain('secret-elite-key');
  expect(diagnosticText).not.toContain('Seed');
  expect(diagnosticText).not.toContain(JSON.stringify(output));
});

it.each([
  ['missing calls', { choices: [{ message: { content: null } }] }, 'tool_calls required'],
  ['multiple calls', { choices: [{ message: { tool_calls: [{ function: { name: ELITE_TOOL_NAME, arguments: JSON.stringify(output) } }, { function: { name: ELITE_TOOL_NAME, arguments: JSON.stringify(output) } }] } }] }, 'exactly one tool call required'],
  ['wrong function', toolCompletion(output, 'other_function'), 'unexpected tool function'],
  ['non-string args', { choices: [{ message: { tool_calls: [{ function: { name: ELITE_TOOL_NAME, arguments: output } }] } }] }, 'function arguments must be a string'],
  ['malformed JSON', { choices: [{ message: { tool_calls: [{ function: { name: ELITE_TOOL_NAME, arguments: '{bad' } }] } }] }, 'function arguments JSON parsing'],
  ['invalid schema', toolCompletion({ candidates: [candidate] }), 'ESSE recommendation schema validation']
])('rejects Mistral tool response with %s', async (_name, envelope, rejectionStage) => {
  const inspections: unknown[] = [];
  const provider = new EliteProvider('secret-elite-key', 'mistral-small-4', 'https://elite.test/v1', fetchJson(envelope), undefined, 15000, event => inspections.push(event));
  await expect(provider.candidates({ title: 'Seed' })).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' });
  expect(inspections[0]).toMatchObject({ outputMode: 'tool-call', rejectionStage });
});

it('allows valid Mistral tool output into the existing Elite-primary pipeline and falls back to Gemini for invalid tool output', async () => {
  const elite = new EliteProvider('key', 'mistral-small-4', 'https://elite.test/v1', fetchJson(toolCompletion(output)));
  const gemini = { seedProfile: profile, candidates: vi.fn(async () => [candidate]) };
  await expect(new EliteGeminiProvider(elite, gemini).candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
  expect(gemini.candidates).not.toHaveBeenCalled();

  resetEliteHealth();
  const invalidElite = new EliteProvider('key', 'mistral-small-4', 'https://elite.test/v1', fetchJson(toolCompletion({ candidates: [candidate] })));
  await expect(new EliteGeminiProvider(invalidElite, gemini).candidates({ title: 'Seed' })).resolves.toEqual([candidate]);
  expect(gemini.candidates).toHaveBeenCalledOnce();
});
