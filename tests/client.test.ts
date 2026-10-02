import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_MS, ESSE_BASE_URL, EsseApiError, EsseClient, type RecommendResponse } from '../client/index';

const apiKey = 'client-test-secret-0123456789';
const result: RecommendResponse = {
  seed: { title: 'Perfect', artist: 'Ed Sheeran' },
  recommendations: [{ title: 'All of Me', artist: 'John Legend' }],
  count: 1,
};
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('uses the production URL, POST, Bearer auth, and the public request body', async () => {
  fetchMock.mockResolvedValue(Response.json(result));
  const client = new EsseClient({ apiKey });
  await expect(client.recommend({ song: 'Perfect', artist: 'Ed Sheeran', limit: 1 })).resolves.toEqual(result);

  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(`${ESSE_BASE_URL}/v1/recommend`);
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
  expect(JSON.parse(String(init?.body))).toEqual({ song: 'Perfect', artist: 'Ed Sheeran', limit: 1 });
  expect(client).toBeInstanceOf(EsseClient);
});

it('lets the API apply its default limit when the caller omits one', async () => {
  fetchMock.mockResolvedValue(Response.json({ ...result, recommendations: [], count: 0 }));
  await new EsseClient({ apiKey }).recommend({ song: 'Perfect' });
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ song: 'Perfect' });
});

it('accepts a custom base URL and strips trailing slashes', async () => {
  fetchMock.mockResolvedValue(Response.json(result));
  await new EsseClient({ apiKey, baseUrl: 'https://api.example.test/esse///' }).recommend({ song: 'Perfect' });
  expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.test/esse/v1/recommend');
});

it('parses safe public HTTP error fields without echoing response text or the API key', async () => {
  fetchMock.mockResolvedValue(Response.json({ error: { code: 'unauthorized', message: `bad key ${apiKey}`, requestId: 'req-safe-123' } }, { status: 401 }));
  let caught: unknown;
  try { await new EsseClient({ apiKey }).recommend({ song: 'Perfect' }); } catch (error) { caught = error; }
  const error = caught as EsseApiError;
  expect(error).toBeInstanceOf(EsseApiError);
  expect(error).toMatchObject({ kind: 'http', status: 401, code: 'unauthorized', requestId: 'req-safe-123' });
  expect(error.message).toBe('ESSE returned HTTP 401.');
  expect(error.toString()).not.toContain(apiKey);
  expect(error.toString()).not.toContain('bad key');
});

it('rejects malformed public success responses', async () => {
  fetchMock.mockResolvedValue(Response.json({ seed: { title: 'Perfect' }, recommendations: [{ title: 'Missing artist' }], count: 1 }));
  await expect(new EsseClient({ apiKey }).recommend({ song: 'Perfect' })).rejects.toMatchObject({ kind: 'invalid_response', status: 200 });
});

it('reports request timeouts and aborts the in-flight fetch', async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const pending = new EsseClient({ apiKey, timeoutMs: 10 }).recommend({ song: 'Perfect' });
  const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', message: 'ESSE request timed out after 10 ms.' });
  await vi.advanceTimersByTimeAsync(10);
  await assertion;
  expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
});

it('uses a bounded default timeout suitable for a cold recommendation', () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
});
