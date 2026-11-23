import { describe, expect, test } from "bun:test";

import {
  folderShortfalls,
  isSavedFolder,
  isSaveProgress,
  uploadedPercent,
} from "../src/transcribe/matter-folder-save";
import type { SavedFolder } from "../src/transcribe/matter-folder-save";

// The shapes `transcribe_save.rs` serializes (`SaveProgress`, `SavedFolder`).
const FOLDER = {
  folderName: "Novák v Stavby Praha – jednání 2026-11-14",
  files: [
    { kind: "transcript", fileName: "Jednání 2026-11-14 přepis.docx" },
    { kind: "cleaned", fileName: "Jednání 2026-11-14 upravený text.docx" },
  ],
  notFiled: [],
  audio: { outcome: "saved", fileName: "Jednání 2026-11-14.m4a" },
} satisfies SavedFolder;

describe("a save to a matter", () => {
  test("reads every progress stage native code reports", () => {
    for (const stage of [
      { stage: "preparing" },
      { stage: "documents" },
      { stage: "uploading", sentBytes: 0, totalBytes: 2_500_000 },
      { stage: "finishing" },
    ]) {
      expect(isSaveProgress(stage)).toBe(true);
    }
    expect(isSaveProgress({ stage: "uploading", sentBytes: 1 })).toBe(false);
    expect(isSaveProgress({ stage: "copying" })).toBe(false);
  });

  test("counts the upload in whole percent, never past 100", () => {
    const uploading = (sentBytes: number, totalBytes: number) =>
      uploadedPercent({ stage: "uploading", sentBytes, totalBytes });
    expect(uploading(1_250_000, 2_500_000)).toBe(50);
    expect(uploading(2_499_999, 2_500_000)).toBe(99);
    expect(uploading(3_000_000, 2_500_000)).toBe(100);
    expect(uploading(0, 0)).toBe(0);
  });

  test("reads a saved folder and says nothing is missing when all of it arrived", () => {
    expect(isSavedFolder(FOLDER)).toBe(true);
    expect(folderShortfalls(FOLDER)).toEqual([]);
    expect(
      folderShortfalls({ ...FOLDER, audio: { outcome: "notIncluded" } }),
    ).toEqual([]);
  });

  test("names each part of the folder that did not arrive", () => {
    expect(
      folderShortfalls({
        ...FOLDER,
        notFiled: ["cleaned"],
        audio: { outcome: "tooLarge", maxBytes: 2_000_000_000 },
      }),
    ).toEqual([
      { kind: "cleanedNotFiled" },
      { kind: "audioTooLarge", maxBytes: 2_000_000_000 },
    ]);
    expect(
      folderShortfalls({ ...FOLDER, audio: { outcome: "missing" } }),
    ).toEqual([{ kind: "audioMissing" }]);
    expect(
      folderShortfalls({ ...FOLDER, audio: { outcome: "failed" } }),
    ).toEqual([{ kind: "audioFailed" }]);
  });

  test("refuses an answer that is not a saved folder", () => {
    expect(isSavedFolder({ fileName: "Jednání přepis.docx" })).toBe(false);
    expect(isSavedFolder({ ...FOLDER, audio: { outcome: "uploaded" } })).toBe(
      false,
    );
  });
});
