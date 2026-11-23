/**
 * What the recorder's level says to the person while they dictate: how
 * loud the microphone hears them, and whether it hears anything at all.
 */
export const DICTATION_LEVEL_RULES = {
  /** The recorder's floor: a microphone giving no signal reads this. */
  floorDb: -160,
  /** Quieter than this reads as an empty meter. */
  quietDb: -55,
  /** Louder than this reads as a full one. */
  loudDb: -10,
  /** Only the floor this long, from the start or since the last sound, is no signal. */
  noSignalMs: 600,
} as const;

/** The level as a share of the meter, 0 to 1; 0 when the recorder reports none. */
export const meterShare = (meteringDb: number | undefined): number => {
  if (meteringDb === undefined) {
    return 0;
  }
  const { quietDb, loudDb } = DICTATION_LEVEL_RULES;
  return Math.min(1, Math.max(0, (meteringDb - quietDb) / (loudDb - quietDb)));
};

/** Since when the microphone has given nothing but its floor, if it has. */
export type SignalWatch = { readonly silentSinceMs: number | null };

export const SIGNAL_UNKNOWN: SignalWatch = { silentSinceMs: null };

/**
 * One reading of the recorder: `atMs` is how long the dictation has run.
 * A microphone at its floor gives no signal at all (muted, taken by
 * another app, or broken), which a quiet room never reads. Says whether
 * there has been no signal for long enough to tell the person.
 */
export const watchSignal = (
  watch: SignalWatch,
  { atMs, meteringDb }: { atMs: number; meteringDb: number | undefined },
): { readonly noSignal: boolean; readonly watch: SignalWatch } => {
  const floor =
    meteringDb !== undefined && meteringDb <= DICTATION_LEVEL_RULES.floorDb;
  if (!floor) {
    return { noSignal: false, watch: SIGNAL_UNKNOWN };
  }
  const silentSinceMs = watch.silentSinceMs ?? atMs;
  return {
    noSignal: atMs - silentSinceMs >= DICTATION_LEVEL_RULES.noSignalMs,
    watch: { silentSinceMs },
  };
};
