import { describe, expect, test } from "bun:test";

import type { DocumentReferenceMatch } from "@/lib/document-reference-queries";
import { resolveVersionOrNewFileDecision } from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog.logic";

const DROPPED_ON = "entity-engagement-letter";

const buildMatch = (
  overrides: Partial<DocumentReferenceMatch> = {},
): DocumentReferenceMatch => ({
  entityId: DROPPED_ON,
  entityName: "Engagement letter.docx",
  workspaceId: "workspace-novak",
  workspaceName: "Novak v. Horak",
  stamp: "2026/001/015.v3",
  versionNumber: 3,
  currentVersionNumber: 3,
  ...overrides,
});

describe("deciding what a dropped file is offered as", () => {
  test("a reference to the document it was dropped on offers the next version", () => {
    const decision = resolveVersionOrNewFileDecision({
      match: buildMatch(),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter (1).docx",
    });

    expect(decision).toEqual({
      type: "reference-here",
      document: {
        entityId: DROPPED_ON,
        workspaceId: "workspace-novak",
        documentName: "Engagement letter.docx",
        matterName: "Novak v. Horak",
        documentReference: "2026/001/015",
        versionNumber: 3,
        nextVersionNumber: 4,
      },
      supersededBase: null,
    });
  });

  test("a reference to another document names that document and its matter", () => {
    const decision = resolveVersionOrNewFileDecision({
      match: buildMatch({
        entityId: "entity-share-purchase",
        entityName: "Share purchase agreement.docx",
        workspaceId: "workspace-kovac",
        workspaceName: "Kovac acquisition",
        stamp: "2026/004/002.v1",
        versionNumber: 1,
        currentVersionNumber: 1,
      }),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Share purchase agreement.docx",
    });

    expect(decision).toEqual({
      type: "reference-elsewhere",
      document: {
        entityId: "entity-share-purchase",
        workspaceId: "workspace-kovac",
        documentName: "Share purchase agreement.docx",
        matterName: "Kovac acquisition",
        documentReference: "2026/004/002",
        versionNumber: 1,
        nextVersionNumber: 2,
      },
      supersededBase: null,
    });
  });

  test("a file taken from a superseded version reports both version numbers", () => {
    const decision = resolveVersionOrNewFileDecision({
      match: buildMatch({ versionNumber: 3, currentVersionNumber: 5 }),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter.docx",
    });

    expect(decision.type).toBe("reference-here");
    if (decision.type === "extension") {
      throw new Error("expected a reference decision");
    }
    expect(decision.supersededBase).toEqual({
      basedOnVersionNumber: 3,
      currentVersionNumber: 5,
    });
    expect(decision.document.nextVersionNumber).toBe(6);
  });

  test("a file taken from the current version reports no supersession", () => {
    const decision = resolveVersionOrNewFileDecision({
      match: buildMatch({ versionNumber: 5, currentVersionNumber: 5 }),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter.docx",
    });

    if (decision.type === "extension") {
      throw new Error("expected a reference decision");
    }
    expect(decision.supersededBase).toBeNull();
  });

  test("a reference whose document has no name leaves the name unset", () => {
    const decision = resolveVersionOrNewFileDecision({
      match: buildMatch({ entityName: null }),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter.docx",
    });

    if (decision.type === "extension") {
      throw new Error("expected a reference decision");
    }
    expect(decision.document.documentName).toBeNull();
  });

  test("a reference with no version suffix is shown whole", () => {
    const decision = resolveVersionOrNewFileDecision({
      match: buildMatch({ stamp: "2026/001/015" }),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter.docx",
    });

    if (decision.type === "extension") {
      throw new Error("expected a reference decision");
    }
    expect(decision.document.documentReference).toBe("2026/001/015");
  });

  test("no reference falls back to matching extensions", () => {
    expect(
      resolveVersionOrNewFileDecision({
        match: null,
        droppedOnEntityId: DROPPED_ON,
        entityFileName: "Engagement letter.docx",
        droppedFileName: "Engagement letter revised.docx",
      }),
    ).toEqual({
      type: "extension",
      canReplace: true,
      entityExtension: "docx",
      uploadExtension: "docx",
    });
  });

  test("no reference and mismatched extensions rules out replacing", () => {
    expect(
      resolveVersionOrNewFileDecision({
        match: null,
        droppedOnEntityId: DROPPED_ON,
        entityFileName: "Engagement letter.docx",
        droppedFileName: "Signed copy.pdf",
      }),
    ).toEqual({
      type: "extension",
      canReplace: false,
      entityExtension: "docx",
      uploadExtension: "pdf",
    });
  });
});
