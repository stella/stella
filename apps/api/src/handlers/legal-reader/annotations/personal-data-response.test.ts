import { describe, expect, test } from "bun:test";

import { projectPrivateAnnotationForAccountExport } from "@/api/handlers/legal-reader/annotations/personal-data-response";
import { createSafeId } from "@/api/lib/branded-types";

const exportingUserId = "exporting-user";
const claimId = createSafeId<"legalListClaim">();
const runId = createSafeId<"legalListVerificationRun">();
const workspaceId = createSafeId<"workspace">();
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
