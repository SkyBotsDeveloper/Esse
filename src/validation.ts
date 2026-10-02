import { AppError, invalid } from './errors';
import type { RecommendInput } from './types';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function validateInput(value: unknown): RecommendInput {
  if (!record(value)) invalid('Request must be a JSON object.');
  if (!validText(value.song)) invalid('song must be a non-empty string of at most 200 characters without control characters.');
  if (value.artist !== undefined && !validText(value.artist)) invalid('artist must be a non-empty string of at most 200 characters without control characters.');
  const limit = value.limit === undefined ? 5 : value.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 5) invalid('limit must be an integer between 1 and 5.');
  return { seed: { title: value.song.trim(), ...(typeof value.artist === 'string' ? { artist: value.artist.trim() } : {}) }, limit };
}

export async function readInput(request: Request): Promise<RecommendInput> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json.');
  }
  const reader = request.body?.getReader();
  if (!reader) invalid('Request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); invalid('Request body must not exceed 4096 bytes.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { invalid('Request body must contain valid JSON.'); }
  return validateInput(parsed);
}
