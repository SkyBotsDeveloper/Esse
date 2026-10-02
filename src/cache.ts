import { normalize } from './normalize';
import type { Song, VerificationProvider, VerifiedSong } from './types';
import { record, validText } from './validation';

export interface VerificationCache {
  get(song: Song): Promise<VerifiedSong | undefined>;
  put(song: Song, result: VerifiedSong): Promise<void>;
}

export class WorkerVerificationCache implements VerificationCache {
  constructor(private cache: Cache, private origin: string) {}
  private async key(song: Song): Promise<Request> {
    const bytes = new TextEncoder().encode(JSON.stringify([normalize(song.title), normalize(song.artist)]));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    return new Request(`${this.origin}/__verification/v2/${hex}`);
  }
  async get(song: Song): Promise<VerifiedSong | undefined> {
    const response = await this.cache.match(await this.key(song));
    if (!response) return undefined;
    const value: unknown = await response.json();
    if (!record(value) || !validText(value.title) || !validText(value.artist) || typeof value.videoId !== 'string' || !/^[\w-]{11}$/.test(value.videoId)) return undefined;
    if (normalize(value.title) !== normalize(song.title) || normalize(value.artist) !== normalize(song.artist)) return undefined;
    if (!record(value.upload) || typeof value.upload.title !== 'string' || !value.upload.title.trim() || value.upload.title.length > 1000 || typeof value.upload.channel !== 'string' || !value.upload.channel.trim() || value.upload.channel.length > 1000) return undefined;
    return { title: value.title, artist: value.artist, videoId: value.videoId, upload: { title: value.upload.title, channel: value.upload.channel } };
  }
  async put(song: Song, result: VerifiedSong): Promise<void> {
    await this.cache.put(await this.key(song), Response.json(result, { headers: { 'cache-control': 'public, max-age=86400' } }));
  }
}

export class CachedVerificationProvider implements VerificationProvider {
  constructor(private provider: VerificationProvider, private cache: VerificationCache, private stats?: { hits: number; misses: number }) {}
  get lastFailureReason() { return this.provider.lastFailureReason; }
  get lastFailureDetail() { return this.provider.lastFailureDetail; }
  async verify(song: Song): Promise<VerifiedSong | null> {
    // Cache failure is optional infrastructure failure; upstream failure must propagate.
    try { const hit = await this.cache.get(song); if (hit) { if (this.stats) this.stats.hits++; return hit; } } catch { /* cache miss */ }
    if (this.stats) this.stats.misses++;
    const verified = await this.provider.verify(song);
    if (verified) { try { await this.cache.put(song, verified); } catch { /* best effort */ } }
    return verified;
  }
}
