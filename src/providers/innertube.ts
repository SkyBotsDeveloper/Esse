import { malformed } from '../errors';
import { upstreamJson } from '../http';
import type { Fetcher } from '../types';
import { record } from '../validation';

// WEB context and video-only filter follow yt-search-python's search concepts.
// Undocumented protocol: update here and add fixtures when YouTube changes it.
export const INNERTUBE = {
  endpoint: 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
  client: { clientName: 'WEB', clientVersion: '2.20250115.01.00', hl: 'en', gl: 'US' },
  clientId: '1',
  videoFilter: 'EgIQAQ%3D%3D',
  timeoutMs: 5000,
  maxResults: 20,
  maxNodes: 200,
  maxDepth: 6
} as const;

export interface SearchVideo { id: string; title: string; channel: string }

function object(value: unknown): Record<string, unknown> {
  if (!record(value)) malformed('YouTube');
  return value;
}
function items(value: unknown): unknown[] {
  if (!Array.isArray(value)) malformed('YouTube');
  return value;
}
function text(value: unknown): string {
  const data = object(value);
  const result = typeof data.simpleText === 'string' ? data.simpleText : items(data.runs).map(run => {
    const part = object(run);
    if (typeof part.text !== 'string') malformed('YouTube');
    return part.text;
  }).join('');
  if (!result.trim() || result.length > 1000) malformed('YouTube');
  return result.trim();
}

/** Only traverse known primary-search containers, never ads or arbitrary nested JSON. */
export function parseSearch(value: unknown): SearchVideo[] {
  const root = object(value);
  if (root.error !== undefined) malformed('YouTube');
  const contents = object(root.contents);
  const primary = object(object(contents.twoColumnSearchResultsRenderer).primaryContents);
  const container = object(primary.sectionListRenderer ?? primary.richGridRenderer);
  const videos: SearchVideo[] = [];
  const seen = new Set<string>();
  let nodes = 0;
  let recognized = false;
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > INNERTUBE.maxNodes || depth > INNERTUBE.maxDepth) malformed('YouTube');
    const node = object(entry);
    if ('videoRenderer' in node) {
      const video = object(node.videoRenderer);
      if (typeof video.videoId !== 'string' || !/^[\w-]{11}$/.test(video.videoId)) malformed('YouTube');
      const result = { id: video.videoId, title: text(video.title), channel: text(video.ownerText ?? video.longBylineText ?? video.shortBylineText) };
      recognized = true;
      if (!seen.has(result.id) && videos.length < INNERTUBE.maxResults) videos.push(result);
      seen.add(result.id);
    } else if ('itemSectionRenderer' in node) {
      for (const child of items(object(node.itemSectionRenderer).contents)) visit(child, depth + 1);
    } else if ('richItemRenderer' in node) {
      visit(object(node.richItemRenderer).content, depth + 1);
    } else if ('backgroundPromoRenderer' in node) {
      // A known explicit empty-search response, not an arbitrary message/challenge.
      const message = text(object(node.backgroundPromoRenderer).title);
      if (message !== 'No results found') malformed('YouTube');
      recognized = true;
    } else if (['continuationItemRenderer', 'adSlotRenderer', 'promotedSparklesWebRenderer', 'searchPyvRenderer', 'channelRenderer', 'playlistRenderer', 'reelShelfRenderer', 'shelfRenderer', 'showingResultsForRenderer', 'didYouMeanRenderer'].some(key => key in node)) {
      // Non-song, sponsored, related shelves and pagination cannot establish a match.
    } else {
      // Includes new video/lockup shapes: missing artist evidence is never verification.
      malformed('YouTube');
    }
  };
  for (const entry of items(container.contents)) visit(entry, 0);
  if (!recognized) malformed('YouTube');
  return videos;
}

export async function searchYouTube(query: string, fetcher: Fetcher): Promise<SearchVideo[]> {
  const response = await upstreamJson(fetcher, 'YouTube', INNERTUBE.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-youtube-client-name': INNERTUBE.clientId,
      'x-youtube-client-version': INNERTUBE.client.clientVersion
    },
    body: JSON.stringify({ context: { client: INNERTUBE.client }, query, params: INNERTUBE.videoFilter })
  }, INNERTUBE.timeoutMs);
  return parseSearch(response);
}
