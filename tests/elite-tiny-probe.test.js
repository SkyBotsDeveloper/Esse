import { expect, it, vi } from 'vitest';
import { ELITE_CANDIDATE_MODELS, probeEliteModel } from '../scripts/elite-tiny-probe.mjs';

it('probes each selected candidate with one tiny, non-streaming request and parses the JSON response', async () => {
  const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
  const result = await probeEliteModel({ key: 'test-secret', model: ELITE_CANDIDATE_MODELS[0], baseUrl: 'https://elite.test/v1', fetcher });
  expect(result).toMatchObject({ httpStatus: 200, choicesExists: true, choicesType: 'array', choicesLength: 1, messageExists: true, contentExists: true, contentType: 'string', jsonValid: true, failureType: null });
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://elite.test/v1/chat/completions');
  expect(JSON.parse(init.body)).toMatchObject({ model: ELITE_CANDIDATE_MODELS[0], stream: false, max_tokens: 32 });
  expect(JSON.stringify(result)).not.toContain('test-secret');
});

it.each([
  [503, {}, 'http-error'],
  [200, { choices: [] }, 'malformed-envelope'],
  [200, { choices: [{ message: { content: 'not json' } }] }, 'invalid-json'],
  [200, { choices: [{ message: { content: '[]' } }] }, 'unexpected-json']
])('classifies sanitized probe failure %s / %s', async (status, body, failureType) => {
  const fetcher = vi.fn(async () => Response.json(body, { status }));
  const result = await probeEliteModel({ key: 'test-secret', model: 'mistral-small-4', baseUrl: 'https://elite.test/v1', fetcher });
  expect(result).toMatchObject({ httpStatus: status, jsonValid: false, failureType });
  expect(JSON.stringify(result)).not.toContain('test-secret');
});
