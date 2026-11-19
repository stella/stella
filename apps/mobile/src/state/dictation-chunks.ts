import { MAX_TRANSCRIPTION_AUDIO_SECONDS } from "@stll/api-contract/transcription";

/**
 * A long dictation is recorded as pieces, each short enough for one
 * transcription, cut where the speaker pauses so no word is split. A piece
 * ends at the first pause once it is long enough to be worth its own
 * request, or, with no pause, just before the transcription's limit.
 */
export const DICTATION_CHUNK_RULES = {
  /** Shorter pieces would only add requests: no cut before this. */
  minimumMs: 15_000,
  /** Cut by then whatever is said, a margin under the transcription's limit. */
  maximumMs: (MAX_TRANSCRIPTION_AUDIO_SECONDS - 5) * 1000,
  /** Quieter than this, in dBFS as the recorder meters, is a pause. */
  silenceDb: -45,
  /** A pause this long is between words, not inside one. */
  pauseMs: 600,
} as const;

/** The longest whole dictation, so a forgotten recording stops by itself. */
export const DICTATION_TOTAL_MAX_MS = 10 * 60 * 1000;

/** Where the current piece stands: since when it has been quiet, if it is. */
export type ChunkWatch = { readonly quietSinceMs: number | null };

export const NO_PAUSE: ChunkWatch = { quietSinceMs: null };

/**
 * One reading of the recorder: how long the current piece has run and how
 * loud the microphone is (undefined when the recorder reports no level).
 * Says whether to cut the piece now, and what to remember for the next
 * reading.
 */
export const watchChunk = (
  watch: ChunkWatch,
  { pieceMs, meteringDb }: { pieceMs: number; meteringDb: number | undefined },
): { readonly cut: boolean; readonly watch: ChunkWatch } => {
  if (pieceMs >= DICTATION_CHUNK_RULES.maximumMs) {
    return { cut: true, watch: NO_PAUSE };
  }
  const quiet =
    meteringDb !== undefined && meteringDb < DICTATION_CHUNK_RULES.silenceDb;
  if (!quiet) {
    return { cut: false, watch: NO_PAUSE };
  }
  const quietSinceMs = watch.quietSinceMs ?? pieceMs;
  const paused = pieceMs - quietSinceMs >= DICTATION_CHUNK_RULES.pauseMs;
  return paused && pieceMs >= DICTATION_CHUNK_RULES.minimumMs
    ? { cut: true, watch: NO_PAUSE }
    : { cut: false, watch: { quietSinceMs } };
};

/** The pieces' texts as one dictation, in the order they were spoken. */
export const joinChunks = (texts: readonly string[]): string =>
  texts
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join(" ");
