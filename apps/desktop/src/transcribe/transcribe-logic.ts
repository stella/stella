/**
 * What the "Transcribe a recording" window reads from native code, and how
 * it lays the pieces of a transcript out: paragraphs with the time they
 * start at, as text to copy or save.
 */

export const TRANSCRIBE_FILE_EVENT = "transcribe-file";
export const TRANSCRIBE_PIECE_EVENT = "transcribe-piece";
export const TRANSCRIBE_FINISHED_EVENT = "transcribe-finished";

export type TranscribeDestination = "local" | "cloud";

export type RefusedReason =
  "dictaphone" | "unsupported" | "tooLong" | "unreadable";

export type FileChoice =
  | {
      status: "ready";
      /** Which choice this is; a start names it back. */
      selection: number;
      name: string;
      format: string;
      durationMs: number | null;
    }
  | { status: "refused"; name: string; reason: RefusedReason };

export type TranscribeSnapshot = {
  available: boolean;
  localReady: boolean;
  cloudAvailable: boolean;
  destination: TranscribeDestination;
  file: FileChoice | null;
  running: number | null;
};

/** The stella AI model a recording goes to; a start names its id back. */
export type RecordingModel = {
  id: string;
  displayName: string;
  provider: string | null;
  retainsData: boolean;
};

export type Started = { job: number; model: RecordingModel | null };

export type PieceText = {
  job: number;
  index: number;
  startMs: number;
  endMs: number;
  pauseBeforeMs: number;
  text: string;
};

export type TranscribeFailure =
  "modelMissing" | "local" | "cloud" | "unreadable" | "tooLong";

export type Finished =
  | { outcome: "done"; job: number; durationMs: number }
  | { outcome: "stopped"; job: number }
  | { outcome: "failed"; job: number; failure: TranscribeFailure };

export type Paragraph = { startMs: number; text: string };

/** A pause at least this long between two pieces starts a new paragraph. */
const PARAGRAPH_PAUSE_MS = 1500;
/** A paragraph that already covers this much speech ends at the next piece. */
const PARAGRAPH_MAX_MS = 90_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REFUSED_REASONS = {
  dictaphone: true,
  unsupported: true,
  tooLong: true,
  unreadable: true,
} satisfies Record<RefusedReason, true>;

const FAILURES = {
  modelMissing: true,
  local: true,
  cloud: true,
  unreadable: true,
  tooLong: true,
} satisfies Record<TranscribeFailure, true>;

export const isFileChoice = (value: unknown): value is FileChoice => {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return false;
  }
  if (value["status"] === "ready") {
    return (
      typeof value["selection"] === "number" &&
      typeof value["format"] === "string" &&
      (value["durationMs"] === null || typeof value["durationMs"] === "number")
    );
  }
  return (
    value["status"] === "refused" &&
    typeof value["reason"] === "string" &&
    Object.hasOwn(REFUSED_REASONS, value["reason"])
  );
};

export const isTranscribeSnapshot = (
  value: unknown,
): value is TranscribeSnapshot =>
  isRecord(value) &&
  typeof value["available"] === "boolean" &&
  typeof value["localReady"] === "boolean" &&
  typeof value["cloudAvailable"] === "boolean" &&
  (value["destination"] === "local" || value["destination"] === "cloud") &&
  (value["file"] === null || isFileChoice(value["file"])) &&
  (value["running"] === null || typeof value["running"] === "number");

export const isRecordingModel = (value: unknown): value is RecordingModel =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["displayName"] === "string" &&
  (value["provider"] === null || typeof value["provider"] === "string") &&
  typeof value["retainsData"] === "boolean";

export const isPieceText = (value: unknown): value is PieceText =>
  isRecord(value) &&
  typeof value["job"] === "number" &&
  typeof value["index"] === "number" &&
  typeof value["startMs"] === "number" &&
  typeof value["endMs"] === "number" &&
  typeof value["pauseBeforeMs"] === "number" &&
  typeof value["text"] === "string";

export const isFinished = (value: unknown): value is Finished => {
  if (!isRecord(value) || typeof value["job"] !== "number") {
    return false;
  }
  switch (value["outcome"]) {
    case "done":
      return typeof value["durationMs"] === "number";
    case "stopped":
      return true;
    case "failed":
      return (
        typeof value["failure"] === "string" &&
        Object.hasOwn(FAILURES, value["failure"])
      );
    default:
      return false;
  }
};

/**
 * Pieces in the order spoken, joined into paragraphs: a piece starts a new
 * paragraph after a long pause, after a piece with no speech, or once the
 * paragraph has run long; otherwise its text continues the one before.
 */
export const paragraphsOf = (pieces: readonly PieceText[]): Paragraph[] => {
  const paragraphs: Paragraph[] = [];
  let current: { startMs: number; texts: string[] } | null = null;
  let breakNext = true;
  for (const piece of pieces.toSorted(
    (left, right) => left.index - right.index,
  )) {
    const text = piece.text.trim();
    if (text === "") {
      breakNext = true;
      continue;
    }
    const startsParagraph =
      current === null ||
      breakNext ||
      piece.pauseBeforeMs >= PARAGRAPH_PAUSE_MS ||
      piece.startMs - current.startMs >= PARAGRAPH_MAX_MS;
    if (startsParagraph) {
      if (current !== null) {
        paragraphs.push({
          startMs: current.startMs,
          text: current.texts.join(" "),
        });
      }
      current = { startMs: piece.startMs, texts: [text] };
    } else {
      current?.texts.push(text);
    }
    breakNext = false;
  }
  if (current !== null) {
    paragraphs.push({
      startMs: current.startMs,
      text: current.texts.join(" "),
    });
  }
  return paragraphs;
};

/** `m:ss`, or `h:mm:ss` from an hour on. */
export const formatTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${minutes}:${twoDigits(seconds)}`;
};

/** The transcript as plain text, paragraphs apart by a blank line. */
export const transcriptText = (
  paragraphs: readonly Paragraph[],
  { timestamps }: { timestamps: boolean },
): string =>
  paragraphs
    .map((paragraph) =>
      timestamps
        ? `[${formatTimestamp(paragraph.startMs)}] ${paragraph.text}`
        : paragraph.text,
    )
    .join("\n\n");

/** Whole minutes for the progress line: a started minute counts. */
export const wholeMinutes = (ms: number): number =>
  Math.max(0, Math.ceil(ms / 60_000));

/** How far a transcription has come, between 0 and 1, when the length is known. */
export const progressShare = (
  doneMs: number,
  totalMs: number | null,
): number | null =>
  totalMs === null || totalMs <= 0
    ? null
    : Math.min(1, Math.max(0, doneMs / totalMs));

/** The recording's name without its extension: the transcript's title. */
export const recordingTitle = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return stem.trim() === "" ? fileName : stem.trim();
};
