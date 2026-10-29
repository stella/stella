import { describe, expect, test } from "bun:test";

import { projectPrivateAnnotationForAccountExport } from "@/api/handlers/legal-reader/annotations/personal-data-response";
import { createSafeId } from "@/api/lib/branded-types";

const exportingUserId = "exporting-user";
const claimId = createSafeId<"legalListClaim">();
const runId = createSafeId<"legalListVerificationRun">();
const workspaceId = createSafeId<"workspace">();
const entityId = createSafeId<"entity">();
const fieldId = createSafeId<"field">();
const createdAt = new Date("2026-10-18T10:00:00.000Z");
const updatedAt = new Date("2026-10-18T11:00:00.000Z");

const claimComment = (userId: string) => ({
  id: createSafeId<"legalReaderAnnotation">(),
  userId,
  targetType: "verification-claim" as const,
  targetId: claimId,
  workspaceId,
  verificationRunId: runId,
  verificationClaimId: claimId,
  entityId: null,
  pageTextSha256: null,
  groupId: null,
  kind: "comment" as const,
  visibility: "shared" as const,
  color: null,
  style: null,
  blockAnchorId: "claim",
  startOffset: 0,
  endOffset: 5,
  quote: "Claim",
  quotePrefix: "",
  quoteSuffix: "",
  body: "The author's comment",
  createdAt,
  updatedAt,
});

const sharedDocumentHighlight = {
  id: createSafeId<"legalReaderAnnotation">(),
  userId: exportingUserId,
  targetType: "matter-document" as const,
  targetId: fieldId,
  workspaceId,
  verificationRunId: null,
  verificationClaimId: null,
  entityId,
  pageTextSha256: "a".repeat(64),
  groupId: null,
  kind: "highlight" as const,
  visibility: "shared" as const,
  color: "yellow" as const,
  style: "highlight" as const,
  blockAnchorId: "page-2",
  startOffset: 4,
  endOffset: 19,
  quote: "deliver the goods",
  body: null,
  createdAt,
  updatedAt,
};

describe("claim comments in a personal-data response", () => {
  test("includes the author's shared comment and its claim linkage", () => {
    expect(
      projectPrivateAnnotationForAccountExport(claimComment(exportingUserId)),
    ).toEqual({
      id: expect.any(String),
      userId: exportingUserId,
      targetType: "verification-claim",
      targetId: claimId,
      workspaceId,
      verificationRunId: runId,
      verificationClaimId: claimId,
      entityId: null,
      pageTextSha256: null,
      groupId: null,
      kind: "comment",
      visibility: "shared",
      color: null,
      style: null,
      blockAnchorId: "claim",
      startOffset: 0,
      endOffset: 5,
      quote: "Claim",
      quotePrefix: "",
      quoteSuffix: "",
      body: "The author's comment",
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
  });
});

describe("matter document marks in a personal-data response", () => {
  test("includes the author's shared mark with its document and page anchor", () => {
    expect(
      projectPrivateAnnotationForAccountExport(sharedDocumentHighlight),
    ).toMatchObject({
      targetType: "matter-document",
      targetId: fieldId,
      entityId,
      pageTextSha256: "a".repeat(64),
      blockAnchorId: "page-2",
      visibility: "shared",
    });
  });

  test("leaves out a shared public-law note, which stays organization data", () => {
    expect(
      projectPrivateAnnotationForAccountExport({
        ...sharedDocumentHighlight,
        targetType: "decision",
        workspaceId: null,
        entityId: null,
        pageTextSha256: null,
      }),
    ).toBeUndefined();
  });
});
