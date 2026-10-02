import { AppError, malformed } from './errors';
import type { Fetcher } from './types';

export async function upstreamJson(fetcher: Fetcher, provider: string, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || response.status === 403) throw new AppError(503, 'UPSTREAM_UNAVAILABLE', `${provider} is unavailable or its quota was exceeded.`);
      throw new AppError(502, 'UPSTREAM_FAILURE', `${provider} request failed.`);
    }
    try { return await response.json(); } catch { if (controller.signal.aborted) throw new Error(); malformed(provider); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) throw new AppError(504, 'UPSTREAM_TIMEOUT', `${provider} request timed out.`);
    throw new AppError(502, 'UPSTREAM_FAILURE', `${provider} request failed.`);
  } finally { clearTimeout(timer); }
}
