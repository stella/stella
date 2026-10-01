import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  documentReviewReferencePassages,
  fields,
  workspaceMembers,
} from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { resolveDocumentReviewRunInputs } from "@/api/lib/document-review/run-inputs";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();
const passageId = createSafeId<"documentReviewReferencePassage">();
const originalField = await testDb.query.fields.findFirst({
  where: { id: { eq: ids.fieldA2 } },
});
const originalMember = (
  await testDb
    .select()
    .from(member)
    .where(eq(member.id, ids.memberA1org))
    .limit(1)
).at(0);
const originalWorkspaceMember = await testDb.query.workspaceMembers.findFirst({
  where: { id: { eq: ids.memberA1wsA2 } },
});
if (!originalField || !originalMember || !originalWorkspaceMember) {
  panic("Review input fixture is incomplete");
}

const referenceContent = {
  version: 1,
  type: "file",
  id: Bun.randomUUIDv7(),
  fileName: "reference.docx",
  mimeType: DOCX_MIME_TYPE,
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: "c".repeat(64),
  pdfFileId: null,
} as const;
const targetPin = {
  workspaceId: ids.wsA1,
  fileFieldId: ids.fileFieldA1,
  entityVersionId: ids.entityVersionA1,
  contentSha256: "a".repeat(64),
};
const referencePin = {
  workspaceId: ids.wsA2,
  fileFieldId: ids.fieldA2,
  entityVersionId: ids.entityVersionA2,
  contentSha256: referenceContent.sha256Hex,
};
const inputs = {
  pins: [targetPin, referencePin],
  passageIds: [passageId],
};
const scopedDb = asTestRaw<ScopedDb>(
  createMembershipScopedDb(testDb, {
    organizationId: ids.orgA,
    userId: ids.userA1,
    serverValidatedWorkspaceIds: [],
  }),
);

beforeAll(async () => {
  await testDb
    .update(fields)
    .set({ content: referenceContent })
    .where(eq(fields.id, ids.fieldA2));
  await testDb.insert(documentReviewReferencePassages).values({
    id: passageId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    entityId: ids.entityA2,
    fileFieldId: ids.fieldA2,
    entityVersionId: ids.entityVersionA2,
    blockId: "review-input-reference",
    text: "Reference terms.",
  });
});

afterEach(async () => {
  await testDb.insert(member).values(originalMember).onConflictDoNothing();
  await testDb
    .insert(workspaceMembers)
    .values(originalWorkspaceMember)
    .onConflictDoNothing();
  await testDb
    .update(fields)
    .set({ content: referenceContent })
    .where(eq(fields.id, ids.fieldA2));
});

afterAll(async () => {
  await testDb
    .delete(documentReviewReferencePassages)
    .where(eq(documentReviewReferencePassages.id, passageId));
  await testDb
    .update(fields)
    .set({ content: originalField.content })
    .where(eq(fields.id, ids.fieldA2));
  await releaseRlsFixture();
});

describe("document review run inputs", () => {
  test("resolves current documents and passages in pin order", async () => {
    const result = await resolveDocumentReviewRunInputs(scopedDb, inputs);
    expect(result.type).toBe("resolved");
    if (result.type !== "resolved") {
      panic("Review inputs did not resolve");
    }
    expect(result.files.map(({ fileFieldId }) => fileFieldId)).toEqual([
      targetPin.fileFieldId,
      referencePin.fileFieldId,
    ]);
    expect(result.passageTextById).toEqual(
      new Map([[passageId, "Reference terms."]]),
    );
    expect(result.files.every(({ pdfFileId }) => pdfFileId === null)).toBe(
      true,
    );
  });

  test("uses current matter membership for pinned documents", async () => {
    expect((await resolveDocumentReviewRunInputs(scopedDb, inputs)).type).toBe(
      "resolved",
    );
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA2));
    expect(await resolveDocumentReviewRunInputs(scopedDb, inputs)).toEqual({
      type: "failed",
      errorCode: "pin_unresolved",
    });
  });

  test("uses current matter membership for position passages", async () => {
    const passageInputs = { pins: [targetPin], passageIds: [passageId] };
    expect(
      (await resolveDocumentReviewRunInputs(scopedDb, passageInputs)).type,
    ).toBe("resolved");
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA2));
    expect(
      await resolveDocumentReviewRunInputs(scopedDb, passageInputs),
    ).toEqual({ type: "failed", errorCode: "pin_unresolved" });
  });

  test("requires current organization membership", async () => {
    expect((await resolveDocumentReviewRunInputs(scopedDb, inputs)).type).toBe(
      "resolved",
    );
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));
    expect(await resolveDocumentReviewRunInputs(scopedDb, inputs)).toEqual({
      type: "failed",
      errorCode: "pin_unresolved",
    });
  });

  test("reports an unavailable file field", async () => {
    expect(
      await resolveDocumentReviewRunInputs(scopedDb, {
        pins: [{ ...targetPin, fileFieldId: createSafeId<"field">() }],
        passageIds: [],
      }),
    ).toEqual({ type: "failed", errorCode: "pin_unresolved" });
  });

  test("requires every position passage to resolve", async () => {
    expect(
      await resolveDocumentReviewRunInputs(scopedDb, {
        pins: [targetPin],
        passageIds: [
          passageId,
          createSafeId<"documentReviewReferencePassage">(),
        ],
      }),
    ).toEqual({ type: "failed", errorCode: "pin_unresolved" });
  });

  test("reports changed file content", async () => {
    await testDb
      .update(fields)
      .set({
        content: { ...referenceContent, sha256Hex: "d".repeat(64) },
      })
      .where(eq(fields.id, ids.fieldA2));
    expect(await resolveDocumentReviewRunInputs(scopedDb, inputs)).toEqual({
      type: "failed",
      errorCode: "pin_content_changed",
    });
  });

  test("reports an unsupported file format", async () => {
    await testDb
      .update(fields)
      .set({
        content: { ...referenceContent, mimeType: "application/pdf" },
      })
      .where(eq(fields.id, ids.fieldA2));
    expect(await resolveDocumentReviewRunInputs(scopedDb, inputs)).toEqual({
      type: "failed",
      errorCode: "unsupported_format",
    });
  });
});
