import { describe, expect, test } from "bun:test";

import {
  canRenameDocumentCrumb,
  resolveCrumbRenameShortcut,
  resolveDocumentRenameSubmission,
  splitFileName,
} from "@/components/breadcrumbs/pdf-breadcrumb.logic";

describe("document crumb rename affordance", () => {
  const renameable = {
    entityId: "entity-1",
    canUpdateEntity: true,
    isLastCrumb: true,
  };

  test("offers a rename on the crumb naming the open document", () => {
    expect(canRenameDocumentCrumb(renameable)).toBe(true);
  });

  test("withholds the rename from a role that cannot update documents", () => {
    expect(
      canRenameDocumentCrumb({ ...renameable, canUpdateEntity: false }),
    ).toBe(false);
  });

  test("withholds the rename while a further crumb follows", () => {
    expect(canRenameDocumentCrumb({ ...renameable, isLastCrumb: false })).toBe(
      false,
    );
  });

  test("withholds the rename when the route names no document", () => {
    expect(canRenameDocumentCrumb({ ...renameable, entityId: "" })).toBe(false);
  });
});

describe("document crumb keyboard shortcut", () => {
  test("Enter and F2 on the focused crumb open the rename field", () => {
    expect(resolveCrumbRenameShortcut("Enter")).toBe("start-rename");
    expect(resolveCrumbRenameShortcut("F2")).toBe("start-rename");
  });

  test("leaves every other key to the crumb, Escape included", () => {
    for (const key of ["Escape", "Tab", " ", "a", "ArrowRight"]) {
      expect(resolveCrumbRenameShortcut(key)).toBe("ignore");
    }
  });
});

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

describe("committing a document crumb rename", () => {
  test("sends the trimmed draft with the stored extension re-appended", () => {
    expect(
      resolveDocumentRenameSubmission({
        draft: "  Kupní smlouva  ",
        currentName: "Draft.docx",
      }),
    ).toEqual({ type: "commit", name: "Kupní smlouva.docx" });
  });

  test("sends nothing when the draft is blank or only whitespace", () => {
    expect(
      resolveDocumentRenameSubmission({ draft: "", currentName: "Draft.docx" }),
    ).toEqual({ type: "discard" });
    expect(
      resolveDocumentRenameSubmission({
        draft: "   ",
        currentName: "Draft.docx",
      }),
    ).toEqual({ type: "discard" });
  });

  test("sends nothing when the name is unchanged", () => {
    expect(
      resolveDocumentRenameSubmission({
        draft: "Draft",
        currentName: "Draft.docx",
      }),
    ).toEqual({ type: "discard" });
    expect(
      resolveDocumentRenameSubmission({
        draft: "  Draft  ",
        currentName: "Draft.docx",
      }),
    ).toEqual({ type: "discard" });
  });

  test("renames a document that has no extension", () => {
    expect(
      resolveDocumentRenameSubmission({
        draft: "Meeting notes",
        currentName: "Notes",
      }),
    ).toEqual({ type: "commit", name: "Meeting notes" });
  });

  test("keeps a dotfile's name whole instead of eating it as an extension", () => {
    expect(
      resolveDocumentRenameSubmission({
        draft: "Read me",
        currentName: ".gitignore",
      }),
    ).toEqual({ type: "commit", name: "Read me" });
  });
});
