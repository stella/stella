import { describe, expect, test } from "bun:test";

import {
  getDesktopEditLockState,
  getPdfDownloadFileName,
} from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions.logic";

describe("save-as-PDF download filenames", () => {
  test("uses the source document base name with a PDF extension", () => {
    expect(getPdfDownloadFileName("Contract.docx")).toBe("Contract.pdf");
    expect(getPdfDownloadFileName("Contract.v2.DOCX")).toBe("Contract.v2.pdf");
  });

  test("appends the PDF extension when the source has no extension", () => {
    expect(getPdfDownloadFileName("Contract")).toBe("Contract.pdf");
  });

  test("does not treat a leading dot as a removable extension", () => {
    expect(getPdfDownloadFileName(".contract")).toBe(".contract.pdf");
  });
});

describe("desktop edit lock actions", () => {
  test("distinguishes an orphanable own session from another user's lock", () => {
    expect(getDesktopEditLockState(null)).toBe("unlocked");
    expect(getDesktopEditLockState({ isMe: true })).toBe("locked-by-me");
    expect(getDesktopEditLockState({ isMe: false })).toBe("locked-by-other");
  });
});
