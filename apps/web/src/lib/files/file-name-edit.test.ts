import { describe, expect, test } from "bun:test";

import {
  resolveFileRenameSubmission,
  splitFileName,
} from "@/lib/files/file-name-edit";

describe("splitting a document name for editing", () => {
  test("separates the extension from the editable base name", () => {
    expect(splitFileName("Share purchase agreement.docx")).toEqual({
      baseName: "Share purchase agreement",
      extension: ".docx",
    });
  });

  test("keeps the last extension of a multi-dot name", () => {
    expect(splitFileName("smlouva.v2.final.pdf")).toEqual({
      baseName: "smlouva.v2.final",
      extension: ".pdf",
    });
  });

  test("treats a leading dot as the name itself, not an extension", () => {
    expect(splitFileName(".gitignore")).toEqual({
      baseName: ".gitignore",
      extension: "",
    });
  });

  test("handles a name without an extension", () => {
    expect(splitFileName("Notes")).toEqual({
      baseName: "Notes",
      extension: "",
    });
  });
});

describe("committing a file rename", () => {
  test("sends the trimmed draft with the stored extension re-appended", () => {
    expect(
      resolveFileRenameSubmission({
        draft: "  Kupní smlouva  ",
        currentName: "Draft.docx",
      }),
    ).toEqual({ type: "commit", name: "Kupní smlouva.docx" });
  });

  test("sends nothing when the draft is blank or only whitespace", () => {
    expect(
      resolveFileRenameSubmission({ draft: "", currentName: "Draft.docx" }),
    ).toEqual({ type: "discard" });
    expect(
      resolveFileRenameSubmission({
        draft: "   ",
        currentName: "Draft.docx",
      }),
    ).toEqual({ type: "discard" });
  });

  test("sends nothing when the name is unchanged", () => {
    expect(
      resolveFileRenameSubmission({
        draft: "Draft",
        currentName: "Draft.docx",
      }),
    ).toEqual({ type: "discard" });
    expect(
      resolveFileRenameSubmission({
        draft: "  Draft  ",
        currentName: "Draft.docx",
      }),
    ).toEqual({ type: "discard" });
  });

  test("sends nothing when only the stored name's padding differs", () => {
    expect(
      resolveFileRenameSubmission({
        draft: "Draft",
        currentName: " Draft.docx",
      }),
    ).toEqual({ type: "discard" });
    expect(
      resolveFileRenameSubmission({
        draft: "Draft",
        currentName: "Draft .docx",
      }),
    ).toEqual({ type: "discard" });
  });

  test("renames a document that has no extension", () => {
    expect(
      resolveFileRenameSubmission({
        draft: "Meeting notes",
        currentName: "Notes",
      }),
    ).toEqual({ type: "commit", name: "Meeting notes" });
  });

  test("keeps a dotfile's name whole instead of eating it as an extension", () => {
    expect(
      resolveFileRenameSubmission({
        draft: "Read me",
        currentName: ".gitignore",
      }),
    ).toEqual({ type: "commit", name: "Read me" });
  });

  test("does not double an extension the draft already ends with", () => {
    expect(
      resolveFileRenameSubmission({
        draft: "minutes.txt",
        currentName: "notes.txt",
      }),
    ).toEqual({ type: "commit", name: "minutes.txt" });
    expect(
      resolveFileRenameSubmission({
        draft: "minutes.TXT",
        currentName: "notes.txt",
      }),
    ).toEqual({ type: "commit", name: "minutes.TXT" });
    expect(
      resolveFileRenameSubmission({
        draft: "notes.txt",
        currentName: "notes.txt",
      }),
    ).toEqual({ type: "discard" });
  });

  test("appends the extension to a draft that only mentions it inside", () => {
    expect(
      resolveFileRenameSubmission({
        draft: "report.txt draft",
        currentName: "report.final.txt",
      }),
    ).toEqual({ type: "commit", name: "report.txt draft.txt" });
  });
});
