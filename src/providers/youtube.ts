import { normalize } from '../normalize';
import type { Fetcher, Song, VerificationFailureReason, VerificationProvider, VerifiedSong } from '../types';
import { searchYouTube, type SearchVideo } from './innertube';

const explicitVersionMarkers = ['slowed reverb', 'sped up', 'fan edit', 'unofficial remix', 'cover', 'karaoke', 'slowed', 'reverb', 'nightcore', 'remix', 'reaction', 'tutorial', 'instrumental', 'live', '8d', 'tribute', 'lofi', 'lo fi', 'teaser', 'trailer', 'shorts', 'status', 'medley', 'review'] as const;
const ambiguousVersionMarkers = ['acoustic', 'edit', 'version'] as const;
const labels = new Set(['t series', 'sony music india', 'sony music entertainment', 'zee music company', 'saregama music', 'tips official', 'yrf', 'sonymusicindiavevo']);
function decodeEntities(value: string): string { return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27|#34);/gi, entity => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#x27;': "'", '&#34;': '"', '&lt;': '<', '&gt;': '>' })[entity.toLowerCase()] ?? entity); }
function contains(haystack: string, needle: string): boolean { return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `); }
function artistAliases(value: string): string[] { return [...new Set(value.split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i).map(normalize).filter(Boolean))]; }
function distanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5) return false;
  let edits = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return true;
}
function containsApprox(haystack: string, needle: string): boolean {
  if (contains(haystack, needle)) return true;
  const words = haystack.split(' '), width = needle.split(' ').length;
  for (let index = 0; index <= words.length - width; index++) {
    if (distanceAtMostOne(words.slice(index, index + width).join(' '), needle)) return true;
  }
  return false;
}
function cleanSegment(value: string): string { return normalize(value).replace(/\b(?:official|full|latest|new|music|video|audio|lyric|lyrics|song|hd|4k|visualizer|soundtrack|ost|fan edit|sped up|slowed reverb|cover|karaoke|slowed|reverb|nightcore|remix|reaction|tutorial|instrumental|live|8d|tribute|lofi|lo fi|teaser|trailer|shorts|status|medley|review|acoustic|edit|version)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
interface VersionMarker { kind: 'explicit' | 'ambiguous'; marker: string }
function versionMarker(title: string, wantedTitle: string, wantedArtist: string): VersionMarker | undefined {
  const applies = (marker: string) => contains(title, marker) && !contains(wantedTitle, marker) && !contains(wantedArtist, marker);
  const explicit = explicitVersionMarkers.find(applies);
  if (explicit) return { kind: 'explicit', marker: explicit === 'slowed reverb' ? 'slowed + reverb' : explicit };
  const ambiguous = ambiguousVersionMarkers.find(applies);
  return ambiguous ? { kind: 'ambiguous', marker: ambiguous } : undefined;
}
interface Match { score: number; diagnosticScore: number; reason?: VerificationFailureReason; marker?: string }
function assessMatch(song: Song, video: SearchVideo): Match {
  const rawTitle = decodeEntities(video.title), title = normalize(rawTitle), channel = normalize(decodeEntities(video.channel)), wantedTitle = normalize(song.title), wantedArtist = normalize(song.artist);
  const aliases = artistAliases(song.artist), phraseMatch = contains(title, wantedTitle);
  const segments = rawTitle.split(/\s+[-–—]\s+|[|:]/u).map(cleanSegment).filter(Boolean);
  const exactOrClose = segments.some(segment => segment === wantedTitle || distanceAtMostOne(segment, wantedTitle));
  if (!exactOrClose && !(wantedTitle.split(' ').length >= 2 && phraseMatch)) return { score: 0, diagnosticScore: 0, reason: 'no strong title match' };
  const artistInTitle = aliases.some(alias => containsApprox(title, alias));
  const artistChannel = aliases.some(alias => [alias, `${alias} official`, `${alias} topic`, `${alias} vevo`, `${alias}vevo`].some(form => distanceAtMostOne(channel, form)));
  const titleScore = exactOrClose ? 50 : 45;
  if (!artistInTitle && !artistChannel) return { score: 0, diagnosticScore: titleScore, reason: 'artist mismatch' };
  const credibleLabel = labels.has(channel) || /\b(?:music|records|recordings|entertainment|vevo)\b/.test(channel);
  const official = /\bofficial (?:music video|video|audio|lyric video|lyrics)\b/.test(title);
  const diagnosticScore = titleScore + (artistChannel ? 30 : 0) + (artistInTitle ? 25 : 0) + (credibleLabel ? 15 : 0) + (official ? 5 : 0);
  const version = versionMarker(title, wantedTitle, wantedArtist);
  if (version?.kind === 'explicit') return { score: 0, diagnosticScore, reason: 'unwanted version', marker: version.marker };
  return diagnosticScore >= 75 ? { score: diagnosticScore, diagnosticScore } : { score: diagnosticScore, diagnosticScore, reason: 'low confidence' };
}
export function matchScore(song: Song, video: SearchVideo): number { return assessMatch(song, video).score; }
export class YouTubeProvider implements VerificationProvider {
  lastFailureReason?: VerificationFailureReason;
  lastFailureDetail?: string;
  constructor(private fetcher: Fetcher = fetch) {}
  async verify(song: Song): Promise<VerifiedSong | null> {
    this.lastFailureReason = undefined;
    this.lastFailureDetail = undefined;
    const videos = await searchYouTube(`${song.title} ${song.artist}`, this.fetcher);
    if (!videos.length) { this.lastFailureReason = 'malformed/no usable results'; return null; }
    const assessed = videos.map(video => ({ video, ...assessMatch(song, video) })).sort((a, b) => b.score - a.score);
    const best = assessed[0];
    if (!best || best.score < 75) {
      const failure = assessed.slice().sort((a, b) => b.diagnosticScore - a.diagnosticScore)[0];
      this.lastFailureReason = failure?.reason ?? 'low confidence';
      if (failure?.reason === 'unwanted version' && failure.marker) this.lastFailureDetail = `marker="${failure.marker}"`;
      return null;
    }
    return { ...song, videoId: best.video.id, upload: { title: best.video.title, channel: best.video.channel } };
  }
}
