import { AppError, malformed } from '../errors';
import { MAX_CANDIDATES, RECOMMENDATION_CANDIDATE_FIELDS, RECOMMENDATION_OUTPUT_FIELDS, RECOMMENDATION_PROFILE_FIELDS, TRANSITION_FIT_VALUES, type Fetcher, type RecommendationCandidate, type RecommendationProvider, type Seed, type SeedProfile } from '../types';
import { GEMINI_INSTRUCTION, parseRecommendationOutput } from './gemini';

export const ELITE_DEFAULTS = { baseUrl: 'https://elite-llms.vercel.app/v1', model: 'gpt-5.6-luna', timeoutMs: 6000, maxOutputTokens: 4096 } as const;
export type EliteOutcome = 'success' | 'http-error' | 'network-error' | 'timeout' | 'invalid-response' | 'cooldown-skip';
export interface EliteAttempt { provider: 'elite'; model: string; attempt: 0 | 1; httpStatus: number | null; outcome: EliteOutcome; latencyMs: number; requestBytes?: number; fallbackReason?: string }
export type EliteObserver = (event: EliteAttempt) => void;
export interface EliteResponseInspection {
  httpStatus: number | null; latencyMs: number; requestBytes?: number; topLevelKeys?: string[]; choicesExists?: boolean; choicesType?: string; choicesLength?: number;
  firstChoiceKeys?: string[]; messageExists?: boolean; messageKeys?: string[]; contentType?: string; contentLength?: number;
  contentFormat?: 'direct JSON' | 'fenced JSON' | 'prose + JSON' | 'another structure'; outputMode?: 'text' | 'tool-call'; toolCallsExists?: boolean; toolCallsLength?: number; functionName?: string; argumentType?: string; argumentsParsed?: boolean;
  rejectionStage?: string; schemaError?: string; sanitizedPreview?: string;
}
export type EliteInspectionObserver = (inspection: EliteResponseInspection) => void;

const ELITE_SEMANTIC_INSTRUCTION = GEMINI_INSTRUCTION
  .replace('Avoid popularity-only choices, broad-genre shortcuts, famous mood-breaking tracks, and seed-artist bias. ', '')
  .replace(' Output only the required concise JSON, with no reasons or prose.', '');
export const ELITE_FORMAT_CONTRACT = `Return exactly one JSON object. No markdown, fences, prose, or extra keys. Field names are an API contract and must not be renamed, expanded, or replaced with synonyms.
Top-level keys exactly: ${RECOMMENDATION_OUTPUT_FIELDS.join(', ')}.
seedProfile keys exactly: ${RECOMMENDATION_PROFILE_FIELDS.join(', ')}.
Each candidate keys exactly: ${RECOMMENDATION_CANDIDATE_FIELDS.join(', ')}.
Fit values are strong, acceptable, or weak; transitionScore is an integer 0–100.`;
export const ELITE_INSTRUCTION = `${ELITE_SEMANTIC_INSTRUCTION}\n\n${ELITE_FORMAT_CONTRACT}`;

export const ELITE_TOOL_NAME = 'submit_esse_recommendations';
const profileProperties = Object.fromEntries(RECOMMENDATION_PROFILE_FIELDS.map(field => [field, { type: 'string' }])) as Record<(typeof RECOMMENDATION_PROFILE_FIELDS)[number], { type: 'string' }>;
const candidateProperties = Object.fromEntries(RECOMMENDATION_CANDIDATE_FIELDS.map(field => [field,
  field === 'title' || field === 'artist' ? { type: 'string' } :
    field === 'transitionScore' ? { type: 'integer', minimum: 0, maximum: 100 } : { type: 'string', enum: [...TRANSITION_FIT_VALUES] }
])) as unknown as Record<(typeof RECOMMENDATION_CANDIDATE_FIELDS)[number], Record<string, unknown>>;
export const ELITE_RECOMMENDATION_TOOL = {
  type: 'function',
  function: {
    name: ELITE_TOOL_NAME,
    description: 'Submit the ESSE seed profile and ranked next-song candidates.',
    parameters: {
      type: 'object', additionalProperties: false, required: RECOMMENDATION_OUTPUT_FIELDS,
      properties: {
        seedProfile: { type: 'object', additionalProperties: false, required: RECOMMENDATION_PROFILE_FIELDS, properties: profileProperties },
        candidates: { type: 'array', maxItems: MAX_CANDIDATES, items: { type: 'object', additionalProperties: false, required: RECOMMENDATION_CANDIDATE_FIELDS, properties: candidateProperties } }
      }
    }
  }
} as const;
export const ELITE_TOOL_INSTRUCTION = `${ELITE_SEMANTIC_INSTRUCTION}\n\nReturn the complete result by calling ${ELITE_TOOL_NAME} exactly once. Do not write the result in message content. Follow the function's exact schema; do not add, omit, rename, or replace fields.`;
const toolCallingModels = new Set(['mistral-small-4']);

function parseToolCall(message: Record<string, unknown>, inspection: EliteResponseInspection) {
  inspection.outputMode = 'tool-call';
  inspection.toolCallsExists = 'tool_calls' in message;
  if (!Array.isArray(message.tool_calls)) { inspection.rejectionStage = 'tool_calls required'; malformed('Elite'); }
  const calls = message.tool_calls as unknown[];
  inspection.toolCallsLength = calls.length;
  if (calls.length !== 1) { inspection.rejectionStage = 'exactly one tool call required'; malformed('Elite'); }
  const call = calls[0];
  if (!call || typeof call !== 'object' || Array.isArray(call)) { inspection.rejectionStage = 'tool call object'; malformed('Elite'); }
  const functionValue = (call as Record<string, unknown>).function;
  if (!functionValue || typeof functionValue !== 'object' || Array.isArray(functionValue)) { inspection.rejectionStage = 'tool function object'; malformed('Elite'); }
  const fn = functionValue as Record<string, unknown>;
  inspection.functionName = typeof fn.name === 'string' ? fn.name : undefined;
  if (fn.name !== ELITE_TOOL_NAME) { inspection.rejectionStage = 'unexpected tool function'; malformed('Elite'); }
  inspection.argumentType = typeof fn.arguments;
  if (typeof fn.arguments !== 'string') { inspection.rejectionStage = 'function arguments must be a string'; malformed('Elite'); }
  inspection.rejectionStage = 'function arguments JSON parsing';
  let value: unknown;
  try { value = JSON.parse(fn.arguments); } catch { malformed('Elite'); }
  inspection.argumentsParsed = true;
  inspection.rejectionStage = 'ESSE recommendation schema validation';
  const result = parseRecommendationOutput(value, issue => { inspection.schemaError = issue; });
  inspection.rejectionStage = undefined;
  return result;
}

type Health = { failures: number; cooldownUntil: number; type: string };
const health = new Map<string, Health>();
const cooldownBase = { 'rate-limit': 30_000, server: 10_000, timeout: 15_000, network: 10_000, auth: 300_000 } as const;
export function resetEliteHealth(): void { health.clear(); }
export function eliteHealth(model = ELITE_DEFAULTS.model): Health | undefined { return health.get(model); }
function cooling(model: string): boolean { return (health.get(model)?.cooldownUntil ?? 0) > Date.now(); }
function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.min(300_000, Number(value) * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(300_000, Math.max(0, timestamp - Date.now())) : 0;
}
function markFailure(model: string, type: keyof typeof cooldownBase, retryMs = 0): void {
  const previous = health.get(model);
  const failures = type === 'auth' ? 1 : (previous?.failures ?? 0) + 1;
  const delay = Math.min(300_000, Math.max(retryMs, cooldownBase[type] * 2 ** Math.min(failures - 1, 3)));
  health.set(model, { failures, cooldownUntil: Date.now() + delay, type });
}
function fallbackReason(status: number | null, kind: 'http' | 'network' | 'timeout' | 'invalid' | 'config'): string {
  if (kind === 'timeout') return 'timeout';
  if (kind === 'network') return 'network failure';
  if (kind === 'invalid') return 'invalid completion';
  if (kind === 'config') return 'provider configuration unavailable';
  if (status === 401 || status === 403) return 'provider authentication/configuration';
  if (status === 429) return 'rate limited';
  if (status && status >= 500) return 'upstream unavailable';
  return `HTTP ${status ?? 'failure'}`;
}

function safeKeys(value: object): string[] {
  return Object.keys(value).map(key => /^[A-Za-z0-9_-]{1,50}$/.test(key) ? key : '[omitted]').slice(0, 30);
}
function sanitizedPreview(content: string, key: string, seed: Seed): string {
  const promptMarker = GEMINI_INSTRUCTION.slice(0, 96);
  if (content.includes(promptMarker)) return '[prompt-like content omitted]';
  let result = content.replaceAll(GEMINI_INSTRUCTION, '[prompt omitted]');
  result = result.replaceAll(JSON.stringify(seed), '[seed input omitted]');
  if (key) result = result.replaceAll(key, '[credential omitted]');
  return result.replace(/Bearer\s+[^\s,"']+/gi, 'Bearer [credential omitted]').slice(0, 1500);
}
function parseContent(content: string, inspection: EliteResponseInspection, key: string, seed: Seed) {
  let text = content.trim();
  const fenced = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  inspection.contentLength = content.length;
  inspection.contentFormat = fenced ? 'fenced JSON' : text.startsWith('{') || text.startsWith('[') ? 'direct JSON' : text.includes('{') ? 'prose + JSON' : 'another structure';
  inspection.sanitizedPreview = sanitizedPreview(content, key, seed);
  if (fenced) text = fenced[1]!.trim();
  let value: unknown;
  inspection.rejectionStage = 'content JSON parsing';
  try { value = JSON.parse(text); } catch { malformed('Elite'); }
  inspection.rejectionStage = 'ESSE recommendation schema validation';
  const result = parseRecommendationOutput(value, issue => { inspection.schemaError = issue; });
  inspection.rejectionStage = undefined;
  return result;
}

async function readCompletion(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) { await reader.cancel(); malformed('Elite'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export class EliteProvider implements RecommendationProvider {
  seedProfile?: SeedProfile;
  constructor(private key: string, readonly model: string = ELITE_DEFAULTS.model, private baseUrl: string = ELITE_DEFAULTS.baseUrl, private fetcher: Fetcher = fetch, private observe?: EliteObserver, private timeoutMs: number = ELITE_DEFAULTS.timeoutMs, private inspect?: EliteInspectionObserver) {}
  get isCoolingDown(): boolean { return cooling(this.model); }
  get diagnosticModel(): string { return this.key && this.model.includes(this.key) ? '[redacted]' : this.model; }
  async candidates(seed: Seed): Promise<RecommendationCandidate[]> {
    this.seedProfile = undefined;
    const safeModel = this.diagnosticModel;
    if (!this.key.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(this.model) || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 20000) {
      try { this.observe?.({ provider: 'elite', model: safeModel, attempt: 1, httpStatus: null, outcome: 'invalid-response', latencyMs: 0, fallbackReason: 'provider configuration unavailable' }); } catch { /* Diagnostics are best effort. */ }
      throw new AppError(503, 'NOT_CONFIGURED', 'Elite provider is not configured.');
    }
    let endpoint: URL;
    try {
      endpoint = new URL(this.baseUrl);
      if ((endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/chat/completions`;
    } catch { throw new AppError(503, 'NOT_CONFIGURED', 'Elite provider is not configured.'); }
    const started = Date.now();
    const useToolCall = toolCallingModels.has(this.model);
    const requestBody = JSON.stringify({ model: this.model, messages: [
      { role: 'system', content: useToolCall ? ELITE_TOOL_INSTRUCTION : ELITE_INSTRUCTION },
      { role: 'user', content: JSON.stringify(seed) }
    ], stream: false, max_tokens: ELITE_DEFAULTS.maxOutputTokens,
    ...(useToolCall ? { tools: [ELITE_RECOMMENDATION_TOOL], tool_choice: { type: 'function', function: { name: ELITE_TOOL_NAME } } } : {}) });
    const requestBytes = new TextEncoder().encode(requestBody).byteLength;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number | null = null;
    let outcome: EliteOutcome = 'network-error';
    let failure: unknown;
    let parsing = false;
    const inspection: EliteResponseInspection = { httpStatus: null, latencyMs: 0, requestBytes, rejectionStage: 'HTTP response' };
    try {
      const response = await this.fetcher(endpoint.toString(), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
        body: requestBody, signal: controller.signal
      });
      status = response.status;
      inspection.httpStatus = status;
      if (!response.ok) {
        outcome = 'http-error';
        const retryMs = retryAfterMs(response.headers.get('retry-after'));
        if (status === 401 || status === 403) markFailure(this.model, 'auth');
        else if (status === 429) markFailure(this.model, 'rate-limit', retryMs);
        else if (status >= 500 || status === 408) markFailure(this.model, 'server', retryMs);
        throw new AppError(status === 401 || status === 403 ? 503 : status >= 500 ? 502 : status === 429 ? 503 : 502, status === 401 || status === 403 ? 'UPSTREAM_AUTH' : 'UPSTREAM_FAILURE', 'Elite provider request failed.');
      }
      const text = await readCompletion(response);
      parsing = true;
      let data: unknown;
      inspection.rejectionStage = 'HTTP response envelope JSON parsing';
      try { data = JSON.parse(text); } catch { malformed('Elite'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) malformed('Elite');
      const envelope = data as Record<string, unknown>;
      inspection.topLevelKeys = safeKeys(envelope);
      inspection.choicesExists = 'choices' in envelope;
      inspection.choicesType = Array.isArray(envelope.choices) ? 'array' : typeof envelope.choices;
      if (!Array.isArray(envelope.choices)) { inspection.rejectionStage = 'choices envelope'; malformed('Elite'); }
      const choices = envelope.choices as unknown[];
      inspection.choicesLength = choices.length;
      if (choices.length < 1) { inspection.rejectionStage = 'choices length'; malformed('Elite'); }
      const choice: unknown = choices[0];
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) { inspection.rejectionStage = 'first choice object'; malformed('Elite'); }
      const firstChoice = choice as Record<string, unknown>;
      inspection.firstChoiceKeys = safeKeys(firstChoice);
      inspection.messageExists = 'message' in firstChoice;
      if (!('message' in firstChoice) || !firstChoice.message || typeof firstChoice.message !== 'object' || Array.isArray(firstChoice.message)) { inspection.rejectionStage = 'first choice message'; malformed('Elite'); }
      const message = firstChoice.message as Record<string, unknown>;
      inspection.messageKeys = safeKeys(message);
      let result: ReturnType<typeof parseRecommendationOutput>;
      if (useToolCall) result = parseToolCall(message, inspection);
      else {
        inspection.outputMode = 'text';
        inspection.contentType = typeof message.content;
        if (!('content' in message) || typeof message.content !== 'string') { inspection.rejectionStage = 'message content'; malformed('Elite'); }
        result = parseContent(message.content as string, inspection, this.key, seed);
      }
      outcome = 'success';
      health.delete(this.model);
      this.seedProfile = result.seedProfile;
      return result.candidates;
    } catch (error) {
      failure = error;
      if (controller.signal.aborted) {
        outcome = 'timeout'; markFailure(this.model, 'timeout');
        failure = new AppError(504, 'UPSTREAM_TIMEOUT', 'Elite provider request timed out.');
      } else if (error instanceof AppError && error.code === 'INVALID_UPSTREAM_RESPONSE') outcome = 'invalid-response';
      else if (status === null || (status === 200 && !parsing)) { outcome = 'network-error'; markFailure(this.model, 'network'); }
      else if (outcome !== 'http-error') outcome = 'invalid-response';
      throw failure;
    } finally {
      clearTimeout(timer);
      inspection.latencyMs = Math.max(0, Date.now() - started);
      try { this.inspect?.(inspection); } catch { /* Diagnostic inspection cannot affect provider behavior. */ }
      try { this.observe?.({ provider: 'elite', model: safeModel, attempt: 1, httpStatus: status, outcome, latencyMs: inspection.latencyMs, requestBytes, ...(outcome === 'success' ? {} : { fallbackReason: fallbackReason(status, outcome === 'timeout' ? 'timeout' : outcome === 'network-error' ? 'network' : outcome === 'invalid-response' ? 'invalid' : outcome === 'http-error' ? 'http' : 'config') }) }); } catch { /* Diagnostics cannot affect provider behavior. */ }
    }
  }
}

export class EliteGeminiProvider implements RecommendationProvider {
  seedProfile?: SeedProfile;
  constructor(private elite: EliteProvider, private gemini: RecommendationProvider, private observe?: EliteObserver) {}
  async candidates(seed: Seed): Promise<RecommendationCandidate[]> {
    if (this.elite.isCoolingDown) {
      this.observe?.({ provider: 'elite', model: this.elite.diagnosticModel, attempt: 0, httpStatus: null, outcome: 'cooldown-skip', latencyMs: 0, fallbackReason: 'cooldown' });
    } else {
      try {
        const result = await this.elite.candidates(seed);
        this.seedProfile = this.elite.seedProfile;
        return result;
      } catch { /* Elite failure is observable at the request boundary; Gemini is the fallback. */ }
    }
    const result = await this.gemini.candidates(seed);
    this.seedProfile = this.gemini.seedProfile;
    return result;
  }
}
