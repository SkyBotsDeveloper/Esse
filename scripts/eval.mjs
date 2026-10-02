import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { ELITE_CANDIDATE_MODELS, probeEliteModel } from './elite-tiny-probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function main() {
  const { values } = parseArgs({ options: {
    'max-seeds': { type: 'string', default: '2' }, seed: { type: 'string' },
    limit: { type: 'string', default: '5' }, dry: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
    category: { type: 'string' }, model: { type: 'string' }, 'thinking-level': { type: 'string' }, 'timeout-ms': { type: 'string' },
    provider: { type: 'string', default: 'gemini' }, 'provider-check': { type: 'boolean', default: false }, 'tiny-probes': { type: 'boolean', default: false }
  } });
  if (values.help) {
    console.log('npm run eval -- [--list] [--category CATEGORY] [--seed ID] [--max-seeds 1..20] [--limit 1..5] [--provider gemini|elite] [--model MODEL] [--thinking-level LEVEL] [--timeout-ms MILLISECONDS] [--tiny-probes] [--dry] [--json] [--provider-check]\nDefaults: two seeds, five recommendations. Provider/model, thinking-level, and timeout overrides are evaluation-only.');
    return;
  }
  const seeds = JSON.parse(await readFile(resolve(root, 'scripts/eval-seeds.json'), 'utf8'));
  if (values.list) {
    console.log('ID | category | song | artist');
    for (const seed of seeds) console.log(`${seed.id} | ${seed.category} | ${seed.title} | ${seed.artist}`);
    return;
  }
  const maxSeeds = Number(values['max-seeds']);
  const limit = Number(values.limit);
  if (!Number.isInteger(maxSeeds) || maxSeeds < 1 || maxSeeds > seeds.length || !Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error(`Use --max-seeds 1..${seeds.length} and --limit 1..5.`);
  }
  if (values.seed && values.category) throw new Error('Use either --seed or --category, not both.');
  if (!['gemini', 'elite'].includes(values.provider)) throw new Error('Invalid evaluation provider. Use gemini or elite.');
  if (values['tiny-probes'] && values.provider !== 'elite') throw new Error('--tiny-probes requires --provider elite.');
  if (values.provider === 'elite' && values['thinking-level']) throw new Error('--thinking-level applies only to the Gemini evaluation provider.');
  const filtered = values.seed ? seeds.filter(seed => seed.id === values.seed)
    : values.category ? seeds.filter(seed => seed.category.toLowerCase() === values.category.trim().toLowerCase()) : seeds;
  const selected = filtered.slice(0, maxSeeds);
  if (!selected.length) throw new Error(values.category ? 'Unknown benchmark category. Use --list.' : 'Unknown seed ID. Use --list.');
  let local = {};
  try { local = parseEnv(await readFile(resolve(root, '.dev.vars'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read local environment configuration.'); }
  const geminiKey = process.env.GEMINI_API_KEY ?? local.GEMINI_API_KEY;
  const eliteKey = process.env.ELITE_API_KEY ?? local.ELITE_API_KEY;
  const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
  const configuredGeminiModel = process.env.GEMINI_MODEL ?? local.GEMINI_MODEL ?? config.vars.GEMINI_MODEL;
  const configuredEliteModel = process.env.ELITE_MODEL ?? local.ELITE_MODEL ?? config.vars.ELITE_MODEL ?? 'gpt-5.6-luna';
  const configuredModel = values.provider === 'elite' ? configuredEliteModel : configuredGeminiModel;
  const key = values.provider === 'elite' ? eliteKey : geminiKey;
  if (!values.dry && (!key?.trim() || key.startsWith('replace-'))) throw new Error(values.provider === 'elite' ? 'ELITE_API_KEY is required. Configure .dev.vars or the environment, or use --dry.' : 'GEMINI_API_KEY is required. Configure .dev.vars or the environment, or use --dry.');
  if (values['tiny-probes']) {
    const baseUrl = process.env.ELITE_BASE_URL ?? local.ELITE_BASE_URL ?? config.vars.ELITE_BASE_URL ?? 'https://elite-llms.vercel.app/v1';
    let failed = false;
    for (const model of ELITE_CANDIDATE_MODELS) {
      const probe = await probeEliteModel({ key, model, baseUrl, timeoutMs: 10000 });
      console.log(JSON.stringify(probe));
      if (!probe.jsonValid || probe.httpStatus !== 200 || probe.latencyMs > 10000) failed = true;
    }
    if (failed) process.exitCode = 1;
    return;
  }

  const bundle = resolve(root, '.wrangler/eval/pipeline.mjs');
  await build({ entryPoints: [resolve(root, 'src/evaluation.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  const { evaluate, ELITE_DEFAULTS, EliteProvider, GEMINI_ATTEMPT_TIMEOUT_MS, GeminiProvider, YouTubeProvider, normalize, parseFallbackModels, supportsThinkingLevel, thinkingLevelForModel } = await import(pathToFileURL(bundle).href);
  const configuredFallbackModels = values.provider === 'gemini' ? parseFallbackModels(process.env.GEMINI_FALLBACK_MODELS ?? local.GEMINI_FALLBACK_MODELS ?? config.vars.GEMINI_FALLBACK_MODELS) : [];
  const configuredModels = [configuredModel, ...(values.provider === 'elite' ? ELITE_CANDIDATE_MODELS : configuredFallbackModels)];
  if (values.model && !configuredModels.includes(values.model)) throw new Error(values.provider === 'elite' ? 'Evaluation model override must match the configured Elite model.' : 'Evaluation model override must name a configured Gemini model.');
  const model = values.model ?? configuredModel;
  const fallbackModels = values.model ? [] : configuredFallbackModels;
  const thinkingLevelOverride = values['thinking-level'];
  if (thinkingLevelOverride && !values.model) throw new Error('--thinking-level requires an explicit --model evaluation override.');
  if (thinkingLevelOverride && !['minimal', 'low', 'medium', 'high'].includes(thinkingLevelOverride)) throw new Error('Invalid evaluation thinking level. Use minimal, low, medium, or high.');
  if (thinkingLevelOverride && !supportsThinkingLevel(model, thinkingLevelOverride)) throw new Error('Selected Gemini model does not support that evaluation thinking level.');
  const effectiveThinkingLevel = values.provider === 'gemini' ? (thinkingLevelOverride ?? thinkingLevelForModel(model)) : undefined;
  const timeoutValue = values['timeout-ms'];
  if (timeoutValue !== undefined && !values.model) throw new Error('--timeout-ms requires an explicit --model evaluation override.');
  const timeoutMsOverride = timeoutValue === undefined ? undefined : Number(timeoutValue);
  if (timeoutValue !== undefined && (!Number.isInteger(timeoutMsOverride) || timeoutMsOverride < 1000 || timeoutMsOverride > 20000)) throw new Error('Invalid evaluation timeout. Use an integer from 1000 to 20000 milliseconds.');
  const eliteBaseUrl = process.env.ELITE_BASE_URL ?? local.ELITE_BASE_URL ?? config.vars.ELITE_BASE_URL ?? ELITE_DEFAULTS.baseUrl;
  const configuredEliteTimeout = Number(process.env.ELITE_TIMEOUT_MS ?? local.ELITE_TIMEOUT_MS ?? config.vars.ELITE_TIMEOUT_MS ?? ELITE_DEFAULTS.timeoutMs);
  const effectiveTimeoutMs = values.provider === 'elite' ? timeoutMsOverride ?? configuredEliteTimeout : timeoutMsOverride ?? GEMINI_ATTEMPT_TIMEOUT_MS;
  if (values.provider === 'elite' && (!Number.isInteger(effectiveTimeoutMs) || effectiveTimeoutMs < 1000 || effectiveTimeoutMs > 20000)) throw new Error('Invalid configured Elite timeout. Use an integer from 1000 to 20000 milliseconds.');
  console.log(`Evaluation provider: ${values.provider}`);
  if (values.model) console.log(`Evaluation model override: ${values.model}`);
  if (thinkingLevelOverride) console.log(`Evaluation thinking level override: ${thinkingLevelOverride}`);
  if (timeoutMsOverride) console.log(`Evaluation timeout override: ${timeoutMsOverride} ms`);
  const attempts = [];
  const observeGemini = event => { attempts.push(event); console.log(`Gemini: ${JSON.stringify(event)}`); };
  const observeElite = event => { attempts.push(event); console.log(`Elite: ${JSON.stringify(event)}`); };
  if (values['provider-check']) {
    if (values.dry) { console.log('Provider check skipped in dry mode.'); return; }
    const { title, artist } = selected[0];
    try {
      const provider = values.provider === 'elite'
        ? new EliteProvider(key, model, eliteBaseUrl, fetch, observeElite, effectiveTimeoutMs, inspection => console.log(`Elite response inspection: ${JSON.stringify(inspection)}`))
        : new GeminiProvider(key, model, fetch, observeGemini, fallbackModels, thinkingLevelOverride, timeoutMsOverride);
      const candidates = await provider.candidates({ title, artist });
      const used = attempts.findLast(event => event.outcome === 'success')?.model;
      console.log(`${values.provider} provider check passed: ${candidates.length} validated candidates; model used: ${used}; zero YouTube calls.`);
    } catch { console.log(`${values.provider} provider check failed. See sanitized attempt diagnostics above.`); process.exitCode = 1; }
    return;
  }
  // CLI has no Workers Cache API. Preserve the same positive-cache wrapper, with a
  // run-scoped 24-hour TTL store shared by all seeds. No secrets or cache on disk.
  const stored = new Map();
  const cacheKey = song => JSON.stringify([normalize(song.title), normalize(song.artist)]);
  const cache = {
    async get(song) { const hit = stored.get(cacheKey(song)); return hit && hit.expires > Date.now() ? hit.value : undefined; },
    async put(song, value) { stored.set(cacheKey(song), { value, expires: Date.now() + 86400000 }); }
  };
  const liveBrain = values.dry ? undefined : values.provider === 'elite'
    ? new EliteProvider(key, model, eliteBaseUrl, fetch, observeElite, effectiveTimeoutMs)
    : new GeminiProvider(key, model, fetch, observeGemini, fallbackModels, thinkingLevelOverride, timeoutMsOverride);
  const liveVerifier = values.dry ? undefined : new YouTubeProvider();
  const reports = [];
  console.log(values.dry ? 'DRY / MOCK evaluation — no live recommendations or network calls.' : `LIVE evaluation — ${selected.length} seed(s), sequential execution.`);
  for (const { id, title, artist, category } of selected) {
    attempts.length = 0;
    const seed = { title, artist };
    const assessment = { emotionFit: 'strong', energyTempoFit: 'strong', sonicFit: 'strong', themeContextFit: 'strong', transitionScore: 80 };
    // Mock providers exercise the real service, identity filters, backup traversal
    // and cache without duplicating recommendation logic.
    const brain = liveBrain ?? { candidates: async () => [
      { title: `${title} - Official Audio`, artist, ...assessment },
      { title: 'Unavailable fixture', artist, ...assessment },
      ...Array.from({ length: 5 }, (_, i) => ({ title: `Mock recommendation ${i + 1}`, artist: 'Fixture Artist', ...assessment }))
    ] };
    const verifier = liveVerifier ?? { verify: async song => song.title === 'Unavailable fixture' ? null : {
      ...song, videoId: `fixture000${song.title.at(-1)}`, upload: { title: song.title, channel: `${song.artist} - Topic` }
    } };
    const report = await evaluate({ seed, limit }, brain, verifier, cache);
    const modelUsed = attempts.findLast(event => event.outcome === 'success')?.model;
    reports.push({ id, category, mode: values.dry ? 'mock' : 'live', provider: values.provider, modelOverride: values.model, thinkingLevelOverride, effectiveThinkingLevel, timeoutMsOverride, effectiveTimeoutMs, ...report, modelUsed,
      providerLatencyMs: attempts.filter(event => event.attempt === 1).reduce((sum, event) => sum + event.latencyMs, 0), geminiLatencyMs: report.diagnostics.geminiMs, rejectionReasons: report.diagnostics.rejected, providerAttempts: [...attempts] });
    console.log(`\nSeed: ${title} — ${artist}\nCategory: ${category}\nRequested: ${limit}`);
    report.recommendations.forEach((song, i) => console.log(`${i + 1}. ${song.title} — ${song.artist}`));
    if (report.error) { console.log(report.error); process.exitCode = 1; }
    console.log(`Seed profile: ${report.seedProfile ? JSON.stringify(report.seedProfile) : 'none'}\n${values.provider} model: ${modelUsed ?? (values.dry ? 'mock' : 'none')}\n${values.provider === 'gemini' ? `Gemini thinking level: ${effectiveThinkingLevel}\nGemini attempt timeout: ${effectiveTimeoutMs} ms` : `Elite timeout: ${effectiveTimeoutMs} ms`}\nReturned: ${report.recommendations.length}/${limit}\nCandidates: ${report.diagnostics.candidateCount}\nYouTube checks: ${report.youtubeChecks} (verification calls: ${report.diagnostics.verificationAttempts})\nAccepted: ${report.diagnostics.accepted.length}\nRejected: ${report.diagnostics.rejected.length}\nArtist-diversity rejected: ${report.artistDiversityRejected}\nSeed-equivalent rejected: ${report.seedEquivalentRejected}\nCache hits/misses: ${report.cache.hits}/${report.cache.misses}`);
    for (const item of report.diagnostics.rejected) console.log(`  ${item.reason}${item.detail ? ` (${item.detail})` : ''}: ${item.song.title} — ${item.song.artist}`);
    for (const item of report.diagnostics.transitionScores) console.log(`  transition ${item.outcome} (${item.score}): ${item.song.title} — ${item.song.artist}`);
    console.log(`Latency: ${Math.round(report.diagnostics.totalMs)} ms (${values.provider}: ${Math.round(reports.at(-1).providerLatencyMs)}, YouTube: ${Math.round(report.youtubeMs)}, verification including cache: ${Math.round(report.diagnostics.verificationMs)})`);
    // Do not amplify quota/access/parser failures by trying more live seeds.
    if (report.error) break;
  }
  if (values.json) {
    const directory = resolve(root, 'eval-results');
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, `${values.dry ? 'mock' : 'live'}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(reports, null, 2));
    console.log(`\nJSON: ${file}`);
  }
}
main().catch(error => {
  // Only our own fixed CLI validation errors are safe to print.
  const safe = ['Use either --seed or --category, not both.', 'Unknown benchmark category. Use --list.', 'Unknown seed ID. Use --list.', 'Evaluation model override must name a configured Gemini model.', 'Evaluation model override must match the configured Elite model.', '--thinking-level requires an explicit --model evaluation override.', '--thinking-level applies only to the Gemini evaluation provider.', '--tiny-probes requires --provider elite.', 'Invalid evaluation provider. Use gemini or elite.', 'Invalid evaluation thinking level. Use minimal, low, medium, or high.', 'Selected Gemini model does not support that evaluation thinking level.', '--timeout-ms requires an explicit --model evaluation override.', 'Invalid evaluation timeout. Use an integer from 1000 to 20000 milliseconds.', 'Invalid configured Elite timeout. Use an integer from 1000 to 20000 milliseconds.', 'GEMINI_API_KEY is required. Configure .dev.vars or the environment, or use --dry.', 'ELITE_API_KEY is required. Configure .dev.vars or the environment, or use --dry.', 'Could not read local environment configuration.'];
  console.error(safe.includes(error.message) || /^Use --max-seeds 1\.\.[0-9]+ and --limit 1\.\.5\.$/.test(error.message) ? error.message : 'Evaluation setup failed. Check Node 22.12+, arguments, dependencies and configuration.');
  process.exitCode = 1;
});
