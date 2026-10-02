import { AppError, malformed } from '../errors';
import type { Fetcher } from '../types';
import { record } from '../validation';

export const GEMINI_RETRY = { maxAttempts: 3, deadlineMs: 20000, baseDelayMs: 250 } as const;
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const errorStatuses = new Set(['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'UNKNOWN', 'FAILED_PRECONDITION']);
const fields = new Set(['responseFormat', 'response_format', 'mimeType', 'mime_type', 'responseMimeType', 'responseJsonSchema', 'generationConfig', 'generation_config', 'systemInstruction', 'maxOutputTokens', 'schema', 'additionalProperties', 'maxItems']);

export interface GeminiAttempt {
  model: string;
  thinkingLevel?: GeminiThinkingLevel;
  attempt: number;
  httpStatus: number | null;
  outcome: 'success' | 'http-error' | 'network-error' | 'timeout' | 'invalid-response' | 'cooldown-skip';
  latencyMs: number;
  requestBytes: number;
  upstreamCode?: number;
  upstreamStatus?: string;
  upstreamMessage?: string;
}
export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type GeminiObserver = (attempt: GeminiAttempt) => void;

export class GeminiRequestError extends AppError {
  constructor(status: number, code: string, message: string, public readonly fallbackEligible: boolean, public readonly retryAfterMs = 0, public readonly transientType?: 'rate-limit' | 'server' | 'timeout' | 'network') {
    super(status, code, message);
  }
}

/** Canonical summaries rather than raw error text: upstreams may echo secrets/prompts. */
export function safeGeminiError(value: unknown): Pick<GeminiAttempt, 'upstreamCode' | 'upstreamStatus' | 'upstreamMessage'> {
  if (!record(value) || !record(value.error)) return {};
  const error = value.error;
  const result: ReturnType<typeof safeGeminiError> = {};
  if (typeof error.code === 'number' && Number.isInteger(error.code) && error.code >= 100 && error.code <= 599) result.upstreamCode = error.code;
  if (typeof error.status === 'string' && errorStatuses.has(error.status)) result.upstreamStatus = error.status;
  if (typeof error.message !== 'string') return result;
  const message = error.message;
  const field = /Unknown name ["']([^"']+)["']/i.exec(message)?.[1];
  const invalidPath = /Invalid value at ['"]([^'"]+)['"]/i.exec(message)?.[1];
  if (field) result.upstreamMessage = `Invalid JSON payload: unknown field ${fields.has(field) ? field : '[omitted]'}.`;
  else if (invalidPath) {
    const safePath = invalidPath.split('.').every(part => /^(?:generation_config|response_format|text|mime_type|response_mime_type|response_json_schema|properties|items|max_items|additional_properties|required|type|[a-zA-Z_][a-zA-Z0-9_]{0,40})$/.test(part));
    result.upstreamMessage = `Invalid value at ${safePath ? invalidPath : '[omitted]'}.`;
  }
  else if (/api.?key.*(?:invalid|not valid|expired)/i.test(message)) result.upstreamMessage = 'API key is invalid or expired.';
  else if (/api.?key.*(?:leaked|blocked)/i.test(message)) result.upstreamMessage = 'API key is blocked.';
  else if (/permission|access denied|not authorized|unauthenticated/i.test(message)) result.upstreamMessage = 'Authentication or permission denied.';
  else if (/(?:location|region|country).*(?:not supported|unsupported|not available)/i.test(message)) result.upstreamMessage = 'Caller location is not supported for this API.';
  else if (/model.*(?:not found|not supported|not available)|not found.*model/i.test(message)) result.upstreamMessage = 'Configured model is unavailable or does not support this request.';
  else if (/quota|rate limit|resource exhausted/i.test(message)) result.upstreamMessage = 'Quota or rate limit exceeded.';
  else if (/overload|high demand|capacity/i.test(message)) result.upstreamMessage = 'Model capacity is temporarily unavailable.';
  else if (/internal.*error|internal.*failure/i.test(message)) result.upstreamMessage = 'Internal upstream error.';
  else if (/deadline|timed out|timeout/i.test(message)) result.upstreamMessage = 'Upstream request timed out.';
  else if (/invalid.*(?:argument|payload|parameter)|unsupported.*(?:parameter|field)/i.test(message)) result.upstreamMessage = 'Invalid request parameters.';
  else result.upstreamMessage = 'Unrecognized upstream message omitted.';
  return result;
}

async function errorBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) { await reader.cancel(); return undefined; }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    try { return JSON.parse(body); } catch { return undefined; }
  } finally { reader.releaseLock(); }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(new Error('Deadline')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** All attempts, response reads and backoff share one deadline. No YouTube behavior changes. */
export async function geminiRequest<T>(fetcher: Fetcher, key: string, model: string, body: string, parse: (value: unknown) => T, observe?: GeminiObserver, deadlineAt = Date.now() + GEMINI_RETRY.deadlineMs, maxAttempts: number = GEMINI_RETRY.maxAttempts, attemptOffset = 0, thinkingLevel?: GeminiThinkingLevel): Promise<T> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model) || !key.trim()) {
    throw new AppError(503, 'NOT_CONFIGURED', 'Gemini configuration is invalid.');
  }
  const safeModel = model.includes(key) ? '[redacted]' : model;
  const deadline = deadlineAt;
  const remainingMs = Math.max(0, deadline - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  const timeout = () => new GeminiRequestError(504, 'UPSTREAM_TIMEOUT', 'Gemini request timed out.', true, 0, 'timeout');
  let lastError = new GeminiRequestError(502, 'UPSTREAM_FAILURE', 'Gemini request failed.', true, 0, 'network');
  try {
    for (let localAttempt = 1; localAttempt <= maxAttempts; localAttempt++) {
      const attempt = attemptOffset + localAttempt;
      if (controller.signal.aborted || Date.now() >= deadline) throw timeout();
      const start = Date.now();
      const event: GeminiAttempt = { model: safeModel, thinkingLevel, attempt, httpStatus: null, outcome: 'network-error', latencyMs: 0, requestBytes: new TextEncoder().encode(body).byteLength };
      let retryable = false;
      let retryAfterMs = 0;
      let stage: 'transport' | 'parse' = 'transport';
      let result: T | undefined;
      try {
        const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: controller.signal
        });
        event.httpStatus = response.status;
        if (!response.ok) {
          event.outcome = 'http-error';
          retryable = transientStatuses.has(response.status);
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter) retryAfterMs = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
          lastError = response.status === 429 || response.status === 403
            ? new GeminiRequestError(503, 'UPSTREAM_UNAVAILABLE', 'Gemini is unavailable or its quota was exceeded.', retryable, retryAfterMs, response.status === 429 ? 'rate-limit' : undefined)
            : new GeminiRequestError(502, 'UPSTREAM_FAILURE', 'Gemini request failed.', retryable, retryAfterMs, retryable ? 'server' : undefined);
          Object.assign(event, safeGeminiError(await errorBody(response)));
        } else {
          const text = await response.text();
          stage = 'parse';
          let value: unknown;
          try { value = JSON.parse(text); } catch { malformed('Gemini'); }
          result = parse(value);
          event.outcome = 'success';
        }
      } catch {
        if (controller.signal.aborted) { event.outcome = 'timeout'; lastError = timeout(); retryable = false; }
        else if (stage === 'parse') { event.outcome = 'invalid-response'; lastError = new GeminiRequestError(502, 'INVALID_UPSTREAM_RESPONSE', 'Gemini returned an invalid response.', false); retryable = false; }
        else if (event.httpStatus === null || event.httpStatus === 200) {
          event.outcome = 'network-error'; lastError = new GeminiRequestError(502, 'UPSTREAM_FAILURE', 'Gemini request failed.', true, 0, 'network'); retryable = true;
        }
        // An unreadable error body must not turn a known 400/401/403 into a retry.
      } finally {
        event.latencyMs = Math.max(0, Date.now() - start);
        try {
          if (observe) observe(event);
          else if (event.outcome !== 'success') console.warn(JSON.stringify({ event: 'gemini-upstream', ...event }));
        } catch { /* Diagnostics must never affect provider behavior. */ }
      }
      if (event.outcome === 'success') return result as T;
      if (!retryable || localAttempt === maxAttempts) throw lastError;
      const backoff = GEMINI_RETRY.baseDelayMs * 2 ** (localAttempt - 1) * (0.5 + Math.random());
      const delay = Math.max(Math.round(backoff), retryAfterMs);
      // Never retry earlier than Retry-After or expand the request's time budget.
      if (Date.now() + delay >= deadline) throw lastError;
      try { await pause(delay, controller.signal); } catch { throw timeout(); }
    }
    throw lastError;
  } finally { clearTimeout(timer); }
}
