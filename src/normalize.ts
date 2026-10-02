export function normalize(value: string): string {
  return value.normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
export function titleKey(value: string): string {
  return normalize(value.replace(/\((?:official\s+)?(?:audio|video|music video|lyric video)\)|\[(?:official\s+)?(?:audio|video|music video|lyric video)\]/gi, ''));
}
