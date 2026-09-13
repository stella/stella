import { describe, expect, test } from "bun:test";

import type { DocumentReferenceMatch } from "@stll/api-contract";

import type { DocumentReferenceEvidence } from "@/lib/files/document-reference";
import {
  DOCUMENT_REFERENCE_EVIDENCE,
  REFERENCE_UPLOAD_ACTION,
} from "@/lib/files/document-reference";
import type { ResolvedDocumentReference } from "@/lib/files/document-reference-queries";
import { resolveVersionOrNewFileDecision } from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog.logic";

const DROPPED_ON = "entity-engagement-letter";

const buildReference = (
  overrides: Partial<DocumentReferenceMatch> = {},
  evidence: DocumentReferenceEvidence = DOCUMENT_REFERENCE_EVIDENCE.propertiesAndFooter,
): ResolvedDocumentReference => ({
  match: {
    entityId: DROPPED_ON,
    entityName: "Engagement letter.docx",
    workspaceId: "workspace-novak",
    workspaceName: "Novak v. Horak",
    stamp: "2026/001/015.v3",
    versionNumber: 3,
    currentVersionNumber: 3,
    ...overrides,
  },
  evidence,
});

describe("deciding what a dropped file is offered as", () => {
  test("a reference to the document it was dropped on offers the next version", () => {
    const decision = resolveVersionOrNewFileDecision({
      reference: buildReference(),
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
      defaultAction: REFERENCE_UPLOAD_ACTION.version,
    });
  });

  test("a reference to another document names that document and its matter", () => {
    const decision = resolveVersionOrNewFileDecision({
      reference: buildReference({
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
      defaultAction: REFERENCE_UPLOAD_ACTION.version,
    });
  });

  test("a file taken from a superseded version reports both version numbers", () => {
    const decision = resolveVersionOrNewFileDecision({
      reference: buildReference({ versionNumber: 3, currentVersionNumber: 5 }),
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
      reference: buildReference({ versionNumber: 5, currentVersionNumber: 5 }),
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
      reference: buildReference({ entityName: null }),
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
      reference: buildReference({ stamp: "2026/001/015" }),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter.docx",
    });

    if (decision.type === "extension") {
      throw new Error("expected a reference decision");
    }
    expect(decision.document.documentReference).toBe("2026/001/015");
  });

  test.each([
    DOCUMENT_REFERENCE_EVIDENCE.propertiesAndFooter,
    DOCUMENT_REFERENCE_EVIDENCE.footerOnly,
  ])("a file that still shows its reference line leads with %s", (evidence) => {
    const decision = resolveVersionOrNewFileDecision({
      reference: buildReference({}, evidence),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter.docx",
    });

    if (decision.type === "extension") {
      throw new Error("expected a reference decision");
    }
    expect(decision.defaultAction).toBe(REFERENCE_UPLOAD_ACTION.version);
  });

  // The deleted line is the user's own signal that this is a new document, so
  // the hidden property alone must not file it onto the old one.
  test("a file whose reference line was removed leads with a new document", () => {
    const decision = resolveVersionOrNewFileDecision({
      reference: buildReference({}, DOCUMENT_REFERENCE_EVIDENCE.propertiesOnly),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter.docx",
    });

    expect(decision.type).toBe("reference-here");
    if (decision.type === "extension") {
      throw new Error("expected a reference decision");
    }
    expect(decision.defaultAction).toBe(REFERENCE_UPLOAD_ACTION.newDocument);
    // The document it names is still reported: the version offer stays on the
    // dialog, it just no longer leads.
    expect(decision.document.nextVersionNumber).toBe(4);
  });

  test("a removed reference line leads with a new document elsewhere too", () => {
    const decision = resolveVersionOrNewFileDecision({
      reference: buildReference(
        { entityId: "entity-share-purchase", workspaceId: "workspace-kovac" },
        DOCUMENT_REFERENCE_EVIDENCE.propertiesOnly,
      ),
      droppedOnEntityId: DROPPED_ON,
      entityFileName: "Engagement letter.docx",
      droppedFileName: "Engagement letter.docx",
    });

    expect(decision.type).toBe("reference-elsewhere");
    if (decision.type === "extension") {
      throw new Error("expected a reference decision");
    }
    expect(decision.defaultAction).toBe(REFERENCE_UPLOAD_ACTION.newDocument);
  });

  test("no reference falls back to matching extensions", () => {
    expect(
      resolveVersionOrNewFileDecision({
        reference: null,
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
        reference: null,
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
