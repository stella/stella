/**
 * A review run is a record of a document, not of one version of it. A file
 * field is a row of one entity version, so the id a caller holds after a save
 * names only the version it is looking at; the history has to come back for
 * that id all the same, or every accepted redline orphans the run that
 * proposed it.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  documentReviewRuns,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listDocumentReviewRuns from "./list-runs";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;

const seededRunIds: SafeId<"documentReviewRun">[] = [];
const laterVersionId = toSafeId<"entityVersion">(Bun.randomUUIDv7());
const laterFieldId = toSafeId<"field">(Bun.randomUUIDv7());

const basis: DocumentReviewRunBasis = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Positions confirmed for this review",
      positions: { version: 3, items: [] },
    },
  },
  references: [],
  perspective: { type: "neutral" },
};

const seedRun = async (target: {
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
}): Promise<SafeId<"documentReviewRun">> => {
  const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
  seededRunIds.push(runId);
  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    fileFieldId: target.fileFieldId,
    entityVersionId: target.entityVersionId,
    contentSha256: "a".repeat(64),
    basis,
    status: "completed",
    total: 0,
    completed: 0,
    finishedAt: new Date(),
    requestedBy: ids.userA1,
  });
  return runId;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
  // The document gains a version: the same property, a new field row.
  await testDb.insert(entityVersions).values({
    id: laterVersionId,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    versionNumber: 2,
  });
  await testDb.insert(fields).values({
    id: laterFieldId,
    workspaceId: ids.wsA1,
    propertyId: ids.propertyA1,
    entityVersionId: laterVersionId,
    content: { version: 1, type: "text", value: "later" },
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: laterVersionId })
    .where(eq(entities.id, ids.entityA1));
});

afterAll(async () => {
  try {
    if (seededRunIds.length > 0) {
      await testDb
        .delete(documentReviewRuns)
        .where(inArray(documentReviewRuns.id, seededRunIds));
    }
    await testDb
      .update(entities)
      .set({ currentVersionId: ids.entityVersionA1 })
      .where(eq(entities.id, ids.entityA1));
    await testDb.delete(fields).where(eq(fields.id, laterFieldId));
    await testDb
      .delete(entityVersions)
      .where(eq(entityVersions.id, laterVersionId));
  } finally {
    await releaseRlsFixture();
  }
});

describe("document review run history across versions", () => {
  test("lists a run made on an earlier version of the document", async () => {
    const earlier = await seedRun({
      fileFieldId: ids.fieldA1,
      entityVersionId: ids.entityVersionA1,
    });
    const later = await seedRun({
      fileFieldId: laterFieldId,
      entityVersionId: laterVersionId,
    });

    const result = await listDocumentReviewRuns.handler(
      asTestRaw<Parameters<typeof listDocumentReviewRuns.handler>[0]>({
        memberRole: { role: "owner" },
        params: { workspaceId: ids.wsA1 },
        query: { entityId: ids.entityA1, fileFieldId: laterFieldId },
        recordAuditEvent: async () => undefined,
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        workspaceId: ids.wsA1,
      }),
    );

    expect(result).toMatchObject({
      items: [
        { id: later, entityVersionId: laterVersionId },
        { id: earlier, entityVersionId: ids.entityVersionA1 },
      ],
    });
  });
});
