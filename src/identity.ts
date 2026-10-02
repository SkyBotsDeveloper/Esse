import { normalize } from './normalize';
import type { Seed } from './types';

/** Primary performing artist, not upload channel or featured-artist formatting. */
export function artistIdentity(value: string): string {
  return normalize(value.split(/\b(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? value)
    .replace(/\s+(?:official|topic|vevo)$/u, '').trim();
}

function baseTitle(song: Seed): string {
  let title = song.title.normalize('NFKC').replace(/['’]/gu, '');
  const artist = song.artist ? artistIdentity(song.artist) : '';
  const segments = title.split(/\s+[-–—]\s+/u);
  if (segments.length > 1 && artist && artistIdentity(segments[0]!) === artist) segments.shift();
  title = segments.join(' - ').split('|')[0] ?? title;
  title = title.replace(/\b(?:feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .replace(/\s*[([](?:from\s+|movie\s*[:=-]?\s*|album\s*[:=-]?\s*)[^)\]]*[)\]]/gi, '')
    .replace(/\s+from\s+.+$/i, '');
  title = title.replace(/\s*[([](?:acoustic|live|remix|reprise|remastered|instrumental)\b[^)\]]*[)\]]/gi, '');
  let key = normalize(title);
  // Strip suffix decorations only, not arbitrary words inside a genuine title.
  const suffix = /\s+(?:(?:(?:official|full)\s+)*(?:music\s+video|lyric\s+video|lyrics?|video|audio)|hd|4k|(?:acoustic|live|remix|reprise|remastered|instrumental|slowed|reverb|sped up)(?:\s+version)?|version)$/u;
  let previous: string;
  do {
    previous = key;
    if (artist && key.endsWith(` ${artist}`)) key = key.slice(0, -artist.length).trim();
    key = key.replace(suffix, '').trim();
  } while (key !== previous);
  return key;
}

/** Deterministic base-song identity; no edit-distance matching of similar titles. */
export function sameSong(left: Seed, right: Seed): boolean {
  const a = baseTitle(left);
  const b = baseTitle(right);
  if (!a || !b || a !== b) return false;
  if (!left.artist || !right.artist) return true;
  return artistIdentity(left.artist) === artistIdentity(right.artist);
}

/** Upload artist evidence can correct a mislabeled candidate credit (e.g. a label). */
export function sameUploadSong(seed: Seed, song: Seed, upload: { title: string; channel: string }): boolean {
  const artist = seed.artist ? artistIdentity(seed.artist) : '';
  const identifiesArtist = artist && (artistIdentity(upload.channel) === artist ||
    ` ${normalize(upload.title)} `.includes(` ${artist} `));
  return sameSong(seed, { title: upload.title, artist: identifiesArtist ? seed.artist : song.artist });
}
