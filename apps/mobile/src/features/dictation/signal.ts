export type RecordingSignal = "speech-or-noise" | "silence" | "no-signal";

export const METER_INTERVAL_MS = 50;
export const NO_SIGNAL_AFTER_MS = 600;
const SILENCE_DB = -54;
const FULL_SCALE_DB = -12;

type RecordingSignalOptions = {
  readonly status: "recording" | "paused" | "finished";
  readonly lastMeterAt: number | null;
  readonly recordingSince: number | null;
  readonly now: number;
  readonly db: number;
};

export const recordingSignal = ({
  status,
  lastMeterAt,
  recordingSince,
  now,
  db,
}: RecordingSignalOptions): RecordingSignal => {
  if (status !== "recording") {
    return "silence";
  }
  const expectedSince =
    recordingSince === null
      ? lastMeterAt
      : Math.max(recordingSince, lastMeterAt ?? recordingSince);
  if (expectedSince === null || now - expectedSince >= NO_SIGNAL_AFTER_MS) {
    return "no-signal";
  }
  return db <= SILENCE_DB ? "silence" : "speech-or-noise";
};

/** A zero-height bucket is drawn as a dim dot rather than a missing sample. */
export const waveformLevel = (db: number): number =>
  Math.max(0, Math.min(1, (db - SILENCE_DB) / (FULL_SCALE_DB - SILENCE_DB)));
