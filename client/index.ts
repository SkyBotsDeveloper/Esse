export const ESSE_BASE_URL = 'https://esse.skybotsdeveloper.workers.dev';
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface RecommendRequest {
  song: string;
  artist?: string;
  limit?: number;
}

export interface Recommendation {
  title: string;
  artist: string;
}

export interface RecommendResponse {
  seed: { title: string; artist?: string };
  recommendations: Recommendation[];
  count: number;
}

export type EsseApiErrorKind = 'http' | 'network' | 'timeout' | 'invalid_response';

export class EsseApiError extends Error {
  readonly name = 'EsseApiError';

  constructor(
    message: string,
    readonly kind: EsseApiErrorKind,
    readonly status?: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface EsseClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPublicResponse(value: unknown, limit: number): value is RecommendResponse {
  if (!isRecord(value) || !isRecord(value.seed) || !Array.isArray(value.recommendations)) return false;
  if (typeof value.seed.title !== 'string' || (value.seed.artist !== undefined && typeof value.seed.artist !== 'string')) return false;
  if (!Number.isInteger(value.count) || value.count !== value.recommendations.length || value.count < 0 || value.count > Math.min(5, limit)) return false;
  return value.recommendations.every(item => isRecord(item) && typeof item.title === 'string' && typeof item.artist === 'string');
}

const publicErrorCodes = new Set([
  'unauthorized', 'invalid_request', 'rate_limited', 'upstream_unavailable',
  'internal_error', 'not_found', 'method_not_allowed',
]);

export class EsseClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: EsseClientOptions) {
    if (!options.apiKey.trim()) throw new TypeError('apiKey must be a non-empty string.');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new RangeError('timeoutMs must be a positive safe integer.');

    const baseUrl = (options.baseUrl ?? ESSE_BASE_URL).replace(/\/+$/u, '');
    let parsed: URL;
    try { parsed = new URL(baseUrl); }
    catch { throw new TypeError('baseUrl must be a valid HTTP(S) URL without credentials, query, or fragment.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError('baseUrl must be a valid HTTP(S) URL without credentials, query, or fragment.');
    }
    this.endpoint = `${baseUrl}/v1/recommend`;
  }

  async recommend(request: RecommendRequest): Promise<RecommendResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new EsseApiError(`ESSE request timed out after ${this.timeoutMs} ms.`, 'timeout');
        }
        throw new EsseApiError('Could not reach the ESSE API.', 'network');
      }

      let body: unknown;
      try { body = await response.json(); }
      catch {
        if (controller.signal.aborted) throw new EsseApiError(`ESSE request timed out after ${this.timeoutMs} ms.`, 'timeout');
        if (!response.ok) body = undefined;
        else throw new EsseApiError('ESSE returned an invalid response.', 'invalid_response', response.status);
      }

      if (!response.ok) {
        const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
        const code = typeof error?.code === 'string' && publicErrorCodes.has(error.code) ? error.code : undefined;
        const requestId = typeof error?.requestId === 'string' && /^[A-Za-z0-9-]{1,80}$/u.test(error.requestId) ? error.requestId : undefined;
        // Do not copy the response message or body into an exception; public gateways can echo caller data.
        throw new EsseApiError(`ESSE returned HTTP ${response.status}.`, 'http', response.status, code, requestId);
      }

      if (!isPublicResponse(body, request.limit ?? 5)) {
        throw new EsseApiError('ESSE returned an invalid response.', 'invalid_response', response.status);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}
