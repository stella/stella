import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  legalListClaims,
  legalListVerificationBlocks,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";
import { completeVerificationRun } from "@/api/lib/lists/verification/run-persistence";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const runId = createSafeId<"legalListVerificationRun">();

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Verification persistence firm",
    slug: `verification-persistence-${Bun.randomUUIDv7()}`,
    createdAt: new Date(),
  });
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Verification persistence matter",
    reference: Bun.randomUUIDv7().slice(0, 8),
  });
  await testDb.insert(legalListVerificationRuns).values({
    id: runId,
    organizationId,
    workspaceId,
    entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
    contentSha256: "a".repeat(64),
    evidence: {
      listId: toSafeId<"legalList">(Bun.randomUUIDv7()),
      facts: [],
    },
    status: "running",
    pipelineVersion: 2,
  });
});

afterAll(async () => {
  await releaseTestDb();
});

test("completion pins source text and claims once", async () => {
  const scopedQuery = createScopedQuery(testDb);
  const claimId = createSafeId<"legalListClaim">();
  const blocks = [
    {
      id: "P1",
      text: " First page.\nSecond line.",
      source: { type: "pdf-page", pageNumber: 1 },
    },
  ] as const;
  const claims = [
    {
      id: claimId,
      runId,
      workspaceId,
      position: 0,
      type: "fact",
      state: "nocover",
      score: null,
      text: "First page.",
      anchor: { type: "pdf-page", pageNumber: 1, start: 1, end: 12 },
      refs: [],
    },
  ] satisfies (typeof legalListClaims.$inferInsert)[];

  await scopedQuery([workspaceId], organizationId, async (tx) => {
    await completeVerificationRun({ tx, runId, workspaceId, blocks, claims });
  });
  await scopedQuery([workspaceId], organizationId, async (tx) => {
    await completeVerificationRun({
      tx,
      runId,
      workspaceId,
      blocks: [{ ...blocks[0], text: "Changed on replay." }],
      claims,
    });
  });

  const stored = await scopedQuery(
    [workspaceId],
    organizationId,
    async (tx) => ({
      run: await tx
        .select({ status: legalListVerificationRuns.status })
        .from(legalListVerificationRuns)
        .where(eq(legalListVerificationRuns.id, runId)),
      blocks: await tx
        .select()
        .from(legalListVerificationBlocks)
        .where(
          and(
            eq(legalListVerificationBlocks.workspaceId, workspaceId),
            eq(legalListVerificationBlocks.runId, runId),
          ),
        ),
      claims: await tx
        .select({ id: legalListClaims.id })
        .from(legalListClaims)
        .where(eq(legalListClaims.runId, runId)),
    }),
  );
  expect(stored.run).toEqual([{ status: "completed" }]);
  expect(stored.blocks).toEqual([
    expect.objectContaining({
      runId,
      workspaceId,
      ordinal: 0,
      blockId: "P1",
      kind: "pdf-page",
      pageNumber: 1,
      text: " First page.\nSecond line.",
    }),
  ]);
  expect(stored.claims).toEqual([{ id: claimId }]);
  const detail = await scopedQuery(
    [workspaceId],
    organizationId,
    async (tx) => await readVerificationRun({ tx, workspaceId, runId }),
  );
  expect(detail?.blocks).toEqual([
    {
      ordinal: 0,
      blockId: "P1",
      kind: "pdf-page",
      pageNumber: 1,
      text: " First page.\nSecond line.",
    },
  ]);
});

test("completion keeps source text when no claims are found", async () => {
  const emptyRunId = createSafeId<"legalListVerificationRun">();
  await testDb.insert(legalListVerificationRuns).values({
    id: emptyRunId,
    organizationId,
    workspaceId,
    entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
    contentSha256: "b".repeat(64),
    evidence: {
      listId: toSafeId<"legalList">(Bun.randomUUIDv7()),
      facts: [],
    },
    status: "running",
    pipelineVersion: 2,
  });
  const detail = await createScopedQuery(testDb)(
    [workspaceId],
    organizationId,
    async (tx) => {
      await completeVerificationRun({
        tx,
        runId: emptyRunId,
        workspaceId,
        blocks: [
          {
            id: "p1",
            text: "The full paragraph.",
            source: { type: "docx-block", blockId: "p1" },
          },
        ],
        claims: [],
      });
      return await readVerificationRun({
        tx,
        workspaceId,
        runId: emptyRunId,
      });
    },
  );
  expect(detail?.status).toBe("completed");
  expect(detail?.claims).toEqual([]);
  expect(detail?.blocks).toEqual([
    {
      ordinal: 0,
      blockId: "p1",
      kind: "docx-block",
      pageNumber: null,
      text: "The full paragraph.",
    },
  ]);
});
