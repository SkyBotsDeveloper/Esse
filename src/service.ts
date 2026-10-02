import { artistIdentity, sameSong, sameUploadSong } from './identity';
import { MAX_CANDIDATES, type RecommendInput, type RecommendOutput, type RecommendationCandidate, type RecommendationProvider, type VerificationProvider, type Song } from './types';
import { invalid, malformed } from './errors';
import { validText } from './validation';
import type { Diagnostics, RejectionReason } from './diagnostics';

export async function recommend(input: RecommendInput, brain: RecommendationProvider, verifier: VerificationProvider, diagnostics?: Diagnostics): Promise<RecommendOutput> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 5) invalid('limit must be an integer between 1 and 5.');
  const start = performance.now();
  const reject = (song: Song, reason: RejectionReason, detail?: string, transitionScore?: number) => {
    diagnostics?.rejected.push({ song: { title: song.title, artist: song.artist }, reason, ...(detail ? { detail } : {}), ...(transitionScore !== undefined ? { transitionScore } : {}) });
    if (transitionScore !== undefined) diagnostics?.transitionScores.push({ song: { title: song.title, artist: song.artist }, score: transitionScore, outcome: 'rejected' });
  };
  try {
    const brainStart = performance.now();
    let pool: RecommendationCandidate[];
    try { pool = await brain.candidates(input.seed); }
    finally { if (diagnostics) diagnostics.geminiMs = performance.now() - brainStart; }
    if (diagnostics) diagnostics.candidateCount = pool.length;
    const seen: Song[] = [];
    const videos = new Set<string>();
    const recommendations: Song[] = [];
    const artistCounts = new Map<string, number>();
    const ranked = pool.slice(0, MAX_CANDIDATES).map((candidate, index) => ({ candidate, index })).sort((left, right) => right.candidate.transitionScore - left.candidate.transitionScore || left.index - right.index);
    for (const { candidate } of ranked) {
      if (!validText(candidate.title) || !validText(candidate.artist) || !['strong', 'acceptable', 'weak'].includes(candidate.emotionFit) || !['strong', 'acceptable', 'weak'].includes(candidate.energyTempoFit) || !['strong', 'acceptable', 'weak'].includes(candidate.sonicFit) || !['strong', 'acceptable', 'weak'].includes(candidate.themeContextFit) || !Number.isInteger(candidate.transitionScore) || candidate.transitionScore < 0 || candidate.transitionScore > 100) malformed('Gemini');
      if (sameSong(input.seed, candidate)) { reject(candidate, 'seed-equivalent', undefined, candidate.transitionScore); continue; }
      if (seen.some(song => sameSong(song, candidate))) { reject(candidate, 'duplicate-song', undefined, candidate.transitionScore); continue; }
      seen.push(candidate);
      const weakReason: RejectionReason | undefined = candidate.emotionFit === 'weak' ? 'weak-emotion-fit' : candidate.energyTempoFit === 'weak' ? 'weak-energy-tempo-fit' : candidate.sonicFit === 'weak' ? 'weak-sonic-fit' : candidate.themeContextFit === 'weak' ? 'weak-theme-context-fit' : undefined;
      if (weakReason) { reject(candidate, weakReason, undefined, candidate.transitionScore); continue; }
      const candidateArtist = artistIdentity(candidate.artist);
      if ((artistCounts.get(candidateArtist) ?? 0) >= 2) { reject(candidate, 'artist-diversity', undefined, candidate.transitionScore); continue; }
      const verificationStart = performance.now();
      if (diagnostics) diagnostics.verificationAttempts++;
      let verified;
      try { verified = await verifier.verify(candidate); }
      finally { if (diagnostics) diagnostics.verificationMs += performance.now() - verificationStart; }
      if (!verified) {
        const detail = verifier.lastFailureReason ? `${verifier.lastFailureReason}${verifier.lastFailureDetail ? `: ${verifier.lastFailureDetail}` : ''}` : undefined;
        reject(candidate, 'unverified', detail, candidate.transitionScore);
        continue;
      }
      if (!validText(verified.title) || !validText(verified.artist) || !verified.videoId) malformed('YouTube');
      // Use performing-artist identity, never a label/channel name as the song artist.
      const uploadSong = verified.upload ? { title: verified.upload.title, artist: verified.artist } : verified;
      if (sameSong(input.seed, verified) || (verified.upload ? sameUploadSong(input.seed, verified, verified.upload) : sameSong(input.seed, uploadSong))) { reject(candidate, 'seed-equivalent', undefined, candidate.transitionScore); continue; }
      if (videos.has(verified.videoId)) { reject(candidate, 'duplicate-video', undefined, candidate.transitionScore); continue; }
      if (recommendations.some(song => sameSong(song, verified) || sameSong(song, uploadSong))) { reject(candidate, 'duplicate-song', undefined, candidate.transitionScore); continue; }
      if (artistIdentity(verified.artist) !== artistIdentity(candidate.artist)) { reject(candidate, 'artist-mismatch', undefined, candidate.transitionScore); continue; }
      seen.push(verified);
      videos.add(verified.videoId);
      const accepted = { title: verified.title, artist: verified.artist };
      recommendations.push(accepted);
      diagnostics?.transitionScores.push({ song: accepted, score: candidate.transitionScore, outcome: 'accepted' });
      artistCounts.set(candidateArtist, (artistCounts.get(candidateArtist) ?? 0) + 1);
      diagnostics?.accepted.push(accepted);
      if (recommendations.length === input.limit) break;
    }
    return { seed: input.seed, recommendations, count: recommendations.length };
  } finally { if (diagnostics) diagnostics.totalMs = performance.now() - start; }
}
