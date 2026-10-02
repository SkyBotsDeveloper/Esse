import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const seeds = JSON.parse(readFileSync(new URL('../scripts/eval-seeds.json', import.meta.url), 'utf8'));
const run = (...args) => spawnSync(process.execPath, ['scripts/eval.mjs', ...args], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8',
  env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', GEMINI_API_KEY: '' }
});

describe('evaluation benchmark and CLI', () => {
  it('has unique stable IDs and all required benchmark fields', () => {
    expect(seeds).toHaveLength(20);
    expect(new Set(seeds.map(seed => seed.id)).size).toBe(seeds.length);
    for (const seed of seeds) {
      expect(seed).toEqual({ id: expect.any(String), title: expect.any(String), artist: expect.any(String), category: expect.any(String) });
      for (const value of Object.values(seed)) expect(value.trim()).not.toBe('');
    }
  });
  it('--list prints every seed without credentials or network access', () => {
    const result = run('--list');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ID | category | song | artist');
    for (const seed of seeds) expect(result.stdout).toContain(`${seed.id} | ${seed.category} | ${seed.title} | ${seed.artist}`);
    expect(result.stdout).not.toContain('Gemini:');
  });
  it('keeps seed filtering and existing dry behavior working', () => {
    const result = run('--seed', 'english-romantic', '--max-seeds', '1', '--dry');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Seed: Perfect');
    expect(result.stdout).not.toContain('Seed: Style');
    expect(result.stdout).toContain('DRY / MOCK evaluation');
  });
  it('filters categories case-insensitively', () => {
    const result = run('--category', 'punjabi heartbreak', '--dry');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Seed: Mann Bharryaa');
    expect(result.stdout).toContain('Category: Punjabi heartbreak');
    expect(result.stdout).not.toContain('Seed: Khaab');
  });
  it('uses a configured evaluation-only model override without changing production config', () => {
    const before = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const result = run('--seed', 'hindi-upbeat', '--max-seeds', '1', '--model', 'gemini-3.5-flash-lite', '--thinking-level', 'low', '--timeout-ms', '12000', '--dry');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Evaluation model override: gemini-3.5-flash-lite');
    expect(result.stdout).toContain('Evaluation thinking level override: low');
    expect(result.stdout).toContain('Gemini thinking level: low');
    expect(result.stdout).toContain('Evaluation timeout override: 12000 ms');
    expect(result.stdout).toContain('Gemini attempt timeout: 12000 ms');
    expect(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).toBe(before);
  });
  it('preserves the model default when no thinking override is supplied', () => {
    const result = run('--seed', 'english-dark-pop', '--max-seeds', '1', '--model', 'gemini-3.5-flash-lite', '--dry');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Evaluation thinking level override:');
    expect(result.stdout).toContain('Gemini thinking level: minimal');
    expect(result.stdout).not.toContain('Evaluation timeout override:');
    expect(result.stdout).toContain('Gemini attempt timeout: 6500 ms');
  });
  it.each(['999', '20001', 'not-a-number'])('rejects invalid evaluation timeout %s before network calls', timeout => {
    const result = run('--model', 'gemini-3.5-flash-lite', '--timeout-ms', timeout, '--dry');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid evaluation timeout. Use an integer from 1000 to 20000 milliseconds.');
  });
  it('rejects invalid thinking levels before network calls', () => {
    const result = run('--model', 'gemini-3.5-flash-lite', '--thinking-level', 'extreme', '--dry');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid evaluation thinking level. Use minimal, low, medium, or high.');
  });
  it('rejects unsupported model and thinking-level combinations', () => {
    const result = run('--model', 'gemini-3.8-flash', '--thinking-level', 'minimal', '--dry');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Selected Gemini model does not support that evaluation thinking level.');
  });
  it('rejects unconfigured model overrides clearly', () => {
    const result = run('--model', 'gemini-unconfigured', '--dry');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Evaluation model override must name a configured Gemini model.');
  });
  it('supports direct Elite evaluation without changing production config', () => {
    const before = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const result = run('--seed', 'hindi-romantic', '--provider', 'elite', '--model', 'gpt-5.6-luna', '--dry');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Evaluation provider: elite');
    expect(result.stdout).toContain('elite model: mock');
    expect(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).toBe(before);
  });
  it('applies Elite evaluation timeout override while retaining 6000 ms production default', () => {
    const before = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const result = run('--seed', 'hindi-romantic', '--provider', 'elite', '--model', 'gpt-5.6-luna', '--timeout-ms', '15000', '--dry');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Evaluation timeout override: 15000 ms');
    expect(result.stdout).toContain('Elite timeout: 15000 ms');
    expect(before).toContain('"ELITE_TIMEOUT_MS": "6000"');
    expect(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).toBe(before);
  });
  it('keeps the Elite evaluation timeout at its configured default without an override', () => {
    const result = run('--seed', 'hindi-romantic', '--provider', 'elite', '--model', 'gpt-5.6-luna', '--dry');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Evaluation timeout override:');
    expect(result.stdout).toContain('Elite timeout: 6000 ms');
  });
  it('rejects Gemini-only thinking overrides with Elite before provider calls', () => {
    const result = run('--provider', 'elite', '--thinking-level', 'low', '--dry');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--thinking-level applies only to the Gemini evaluation provider.');
  });
  it('requires Elite mode for the tiny candidate probes before reading credentials or networking', () => {
    const result = run('--tiny-probes', '--dry');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--tiny-probes requires --provider elite.');
  });
});
