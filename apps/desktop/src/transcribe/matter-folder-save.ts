import { panic } from "better-result";

/**
 * Saving a transcribed recording to a matter as a folder: what the window
 * sends to `transcribe_save_to_matter_folder`, the progress it hears on
 * `transcribe-save-progress`, and what the native side answers.
 */

/** The event native code reports a save's progress on. */
export const TRANSCRIBE_SAVE_PROGRESS_EVENT = "transcribe-save-progress";

export type MatterFolderRequest = {
  matterId: string;
  /** The recording's title, which names the folder. */
  title: string;
  paragraphs: readonly { startMs: number; text: string }[];
  /** The documents' names, in the member's language, without `.docx`. */
  transcriptName: string;
  cleanedName: string;
  /** The label above the dictation's instructions. */
  instructionsLabel: string;
  /** The cleaned-up text, as the speaker left it; `null` without one. */
  cleaned: { markdown: string; instructions: readonly string[] } | null;
};

export type SaveProgress =
  | { stage: "preparing" }
  | { stage: "documents" }
  | { stage: "uploading"; sentBytes: number; totalBytes: number }
  | { stage: "finishing" };

export type SavedAudio =
  | { outcome: "saved"; fileName: string }
  | { outcome: "tooLarge"; maxBytes: number }
  | { outcome: "failed" }
  | { outcome: "missing" }
  | { outcome: "notIncluded" };

export type SavedFolder = {
  folderName: string;
  files: readonly { kind: string; fileName: string }[];
  /** The kinds of document the matter did not take (`cleaned`). */
  notFiled: readonly string[];
  audio: SavedAudio;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export const isSaveProgress = (value: unknown): value is SaveProgress => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["stage"]) {
    case "preparing":
    case "documents":
    case "finishing":
      return true;
    case "uploading":
      return isCount(value["sentBytes"]) && isCount(value["totalBytes"]);
    default:
      return false;
  }
};

const isSavedAudio = (value: unknown): value is SavedAudio => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["outcome"]) {
    case "saved":
      return typeof value["fileName"] === "string";
    case "tooLarge":
      return isCount(value["maxBytes"]);
    case "failed":
    case "missing":
    case "notIncluded":
      return true;
    default:
      return false;
  }
};

export const isSavedFolder = (value: unknown): value is SavedFolder =>
  isRecord(value) &&
  typeof value["folderName"] === "string" &&
  Array.isArray(value["files"]) &&
  value["files"].every(
    (file: unknown) =>
      isRecord(file) &&
      typeof file["kind"] === "string" &&
      typeof file["fileName"] === "string",
  ) &&
  Array.isArray(value["notFiled"]) &&
  value["notFiled"].every((kind: unknown) => typeof kind === "string") &&
  isSavedAudio(value["audio"]);

/** The share of the recording uploaded, in whole percent. */
export const uploadedPercent = (
  progress: Extract<SaveProgress, { stage: "uploading" }>,
): number =>
  progress.totalBytes === 0
    ? 0
    : Math.min(
        100,
        Math.floor((progress.sentBytes / progress.totalBytes) * 100),
      );

/** What did not reach the matter although the folder was saved, in the
 *  order the window says it. */
export type FolderShortfall =
  | { kind: "cleanedNotFiled" }
  | { kind: "audioTooLarge"; maxBytes: number }
  | { kind: "audioFailed" }
  | { kind: "audioMissing" };

export const folderShortfalls = (
  folder: SavedFolder,
): readonly FolderShortfall[] => {
  const shortfalls: FolderShortfall[] = folder.notFiled.includes("cleaned")
    ? [{ kind: "cleanedNotFiled" }]
    : [];
  switch (folder.audio.outcome) {
    case "tooLarge":
      return [
        ...shortfalls,
        { kind: "audioTooLarge", maxBytes: folder.audio.maxBytes },
      ];
    case "failed":
      return [...shortfalls, { kind: "audioFailed" }];
    case "missing":
      return [...shortfalls, { kind: "audioMissing" }];
    case "saved":
    case "notIncluded":
      return shortfalls;
    default:
      folder.audio satisfies never;
      return panic("Unhandled saved recording outcome");
  }
};
