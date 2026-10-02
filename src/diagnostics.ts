import type { Song } from './types';

export type RejectionReason = 'seed-equivalent' | 'duplicate-song' | 'unverified' | 'duplicate-video' | 'artist-mismatch' | 'artist-diversity' | 'weak-emotion-fit' | 'weak-energy-tempo-fit' | 'weak-sonic-fit' | 'weak-theme-context-fit';
export interface Diagnostics {
  candidateCount: number;
  verificationAttempts: number;
  accepted: Song[];
  rejected: { song: Song; reason: RejectionReason; detail?: string; transitionScore?: number }[];
  transitionScores: { song: Song; score: number; outcome: 'accepted' | 'rejected' }[];
  geminiMs: number;
  verificationMs: number;
  totalMs: number;
}
export function createDiagnostics(): Diagnostics {
  return { candidateCount: 0, verificationAttempts: 0, accepted: [], rejected: [], transitionScores: [], geminiMs: 0, verificationMs: 0, totalMs: 0 };
}
