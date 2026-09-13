import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { MATTER_REFERENCE_RETIRED_CODE } from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  documentReferenceCounters,
  entities,
  entityVersions,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamps } from "@/api/lib/document-counter";
import { toDocumentReference } from "@/api/lib/document-reference";
import { insertEntityVersions } from "@/api/lib/entity-versions/insert-entity-version";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
const recordAuditEvent: AuditRecorder = async () => undefined;

// Each test owns the matters it stamps, so the shared fixture's seeded rows
// and their references stay untouched.
const createdWorkspaceIds: SafeId<"workspace">[] = [];

const createMatter = async (
  reference: string,
): Promise<SafeId<"workspace">> => {
  const workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    name: `Matter ${reference}`,
    reference,
    status: "active" as const,
  });
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
};

const setReference = async (
  workspaceId: SafeId<"workspace">,
  reference: string,
) => {
  await testDb
    .update(workspaces)
    .set({ reference })
    .where(eq(workspaces.id, workspaceId));
};

const scopeFor = (workspaceIds: SafeId<"workspace">[]) => ({
  safeDb: asTestRaw<SafeDb>(
    createSafeDb(testDb, workspaceIds, ids.orgA, ids.userA1),
  ),
  scopedDb: asTestRaw<ScopedDb>(
    createScopedDb(testDb, workspaceIds, ids.orgA, ids.userA1),
  ),
});

const allocate = async (workspaceId: SafeId<"workspace">, count: number) => {
  const { scopedDb } = scopeFor([workspaceId]);
  return await scopedDb(
    async (tx) => await allocateEntityStamps({ tx, workspaceId, count }),
  );
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  // The fixture database is shared with every other DB-backed file in the
  // batch, so the matters this file invented are removed again.
  if (createdWorkspaceIds.length > 0) {
    await testDb
      .delete(workspaces)
      .where(inArray(workspaces.id, createdWorkspaceIds));
  }
  await releaseRlsFixture();
});

describe("document stamp allocation across a matter reference", () => {
  test("claims an unissued zero-value ledger before the first stamp", async () => {
    const reference = "ZERO-SEED/2026";
    const matter = await createMatter("ZERO-SEED-TEMP/2026");
    await testDb.insert(documentReferenceCounters).values({
      id: createSafeId<"documentReferenceCounter">(),
      organizationId: ids.orgA,
      reference,
      workspaceId: null,
      lastValue: 0,
    });
    await setReference(matter, reference);

    const [stamp] = await allocate(matter, 1);

    expect(stamp).toEqual({
      docSequence: 1,
      stamp: `${reference}/001.v1`,
    });
    const [ledger] = await testDb
      .select({
        workspaceId: documentReferenceCounters.workspaceId,
        lastValue: documentReferenceCounters.lastValue,
      })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, ids.orgA),
          eq(documentReferenceCounters.reference, reference),
        ),
      );
    expect(ledger).toEqual({ workspaceId: matter, lastValue: 1 });
  });

  test("a retired reference rejects a new matter before allocation", async () => {
    const handoverReference = "HANDOVER/2026";
    const matterA = await createMatter(handoverReference);

    const first = await allocate(matterA, 3);
    expect(first.map(({ stamp }) => stamp)).toEqual([
      `${handoverReference}/001.v1`,
      `${handoverReference}/002.v1`,
      `${handoverReference}/003.v1`,
    ]);

    // Bypass the reference-edit guard to verify allocation also preserves
    // issued ownership when a different matter presents the same reference.
    await setReference(matterA, "HANDOVER-RETIRED/2026");
    const matterB = await createMatter(handoverReference);

    const attempted = await Result.tryPromise({
      try: async () => await allocate(matterB, 2),
      catch: (cause) => cause,
    });
    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error).toMatchObject({
        message: "Document stamp reference belongs to another workspace",
      });
    }
    const [ledger] = await testDb
      .select({
        workspaceId: documentReferenceCounters.workspaceId,
        lastValue: documentReferenceCounters.lastValue,
      })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, ids.orgA),
          eq(documentReferenceCounters.reference, handoverReference),
        ),
      );
    expect(ledger).toEqual({ workspaceId: matterA, lastValue: 3 });
  });

  test("a matter returning to its reference resumes after rejected borrowing", async () => {
    const original = "ROUNDTRIP/2026";
    const interim = "ROUNDTRIP-INTERIM/2026";
    const borrower = "ROUNDTRIP-BORROWER/2026";
    const matter = await createMatter(original);
    const other = await createMatter(borrower);

    const before = await allocate(matter, 2);

    // Rejected borrowing must leave the original owner and counter intact.
    await setReference(matter, interim);
    await setReference(other, original);
    const attempted = await Result.tryPromise({
      try: async () => await allocate(other, 2),
      catch: (cause) => cause,
    });
    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error).toMatchObject({
        message: "Document stamp reference belongs to another workspace",
      });
    }
    await setReference(other, borrower);
    await setReference(matter, original);
    const after = await allocate(matter, 1);

    expect(before.map(({ stamp }) => stamp)).toEqual([
      `${original}/001.v1`,
      `${original}/002.v1`,
    ]);
    expect(after.map(({ stamp }) => stamp)).toEqual([`${original}/003.v1`]);

    const stamps = [...before, ...after].map(({ stamp }) => stamp);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test("a separate matter cannot allocate a claimed reference", async () => {
    const shared = "SHARED/2026";
    const matterA = await createMatter(shared);
    const matterB = await createMatter("SHARED-OTHER/2026");

    const blockA = await allocate(matterA, 2);
    await setReference(matterA, "SHARED-RETIRED/2026");
    await setReference(matterB, shared);
    const attempted = await Result.tryPromise({
      try: async () => await allocate(matterB, 2),
      catch: (cause) => cause,
    });
    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error).toMatchObject({
        message: "Document stamp reference belongs to another workspace",
      });
    }
    expect(blockA.map(({ docSequence }) => docSequence)).toEqual([1, 2]);
  });

  test("a matter with an empty reference gets sequence numbers and no stamp", async () => {
    const matter = await createMatter("");

    const allocated = await allocate(matter, 2);

    expect(allocated).toEqual([
      { docSequence: 1, stamp: null },
      { docSequence: 2, stamp: null },
    ]);
  });
});

describe("matter reference change", () => {
  const changeReference = async (
    workspaceId: SafeId<"workspace">,
    reference: string,
  ) => {
    const { safeDb } = scopeFor([workspaceId]);
    return await Result.gen(() =>
      updateWorkspaceHandler({
        safeDb,
        organizationId: ids.orgA,
        workspaceId,
        recordAuditEvent,
        body: { reference },
      }),
    );
  };

  test("refuses a reference another matter has numbered documents under", async () => {
    const claimed = "CLAIMED/2026";
    const owner = await createMatter(claimed);
    await allocate(owner, 2);
    await setReference(owner, "CLAIMED-MOVED-ON/2026");

    const receiver = await createMatter("RECEIVER/2026");
    const updated = await changeReference(receiver, claimed);

    expect(Result.isError(updated)).toBe(true);
    expect(Result.isError(updated) && updated.error).toMatchObject({
      status: 409,
      code: MATTER_REFERENCE_RETIRED_CODE,
    });

    // The write is refused, not merely reported: the matter keeps its own
    // reference and the ledger keeps its owner.
    const [unchanged] = await testDb
      .select({ reference: workspaces.reference })
      .from(workspaces)
      .where(eq(workspaces.id, receiver));
    expect(unchanged?.reference).toBe("RECEIVER/2026");
  });

  test("refuses a reference whose owning matter was deleted", async () => {
    const orphaned = "ORPHANED/2026";
    const owner = await createMatter(orphaned);
    await allocate(owner, 1);
    await testDb.delete(workspaces).where(eq(workspaces.id, owner));

    // The ledger row outlives the matter with a null owner, which is what
    // keeps the reference retired instead of letting it look unclaimed.
    const [ledger] = await testDb
      .select({ workspaceId: documentReferenceCounters.workspaceId })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, ids.orgA),
          eq(documentReferenceCounters.reference, orphaned),
        ),
      );
    expect(ledger?.workspaceId).toBeNull();

    const receiver = await createMatter("ORPHAN-RECEIVER/2026");
    const updated = await changeReference(receiver, orphaned);

    expect(Result.isError(updated) && updated.error).toMatchObject({
      status: 409,
      code: MATTER_REFERENCE_RETIRED_CODE,
    });
  });

  test("allows the owning matter to return to its own reference", async () => {
    const original = "OWN-RETURN/2026";
    const matter = await createMatter(original);
    await allocate(matter, 2);
    await setReference(matter, "OWN-RETURN-INTERIM/2026");

    const updated = await changeReference(matter, original);

    expect(Result.isOk(updated)).toBe(true);
    expect(Result.isOk(updated) && updated.value).toEqual({});

    // Numbering resumes above the mark the matter already reached under it.
    const next = await allocate(matter, 1);
    expect(next.map(({ stamp }) => stamp)).toEqual([`${original}/003.v1`]);
  });

  test("allows a reference nothing has numbered documents under", async () => {
    const matter = await createMatter("FRESH-BEFORE/2026");

    const updated = await changeReference(matter, "FRESH-AFTER/2026");

    expect(Result.isOk(updated)).toBe(true);
    expect(Result.isOk(updated) && updated.value).toEqual({});
  });
});

describe("reference ledger ownership", () => {
  test("records the matter that first numbers documents under a reference", async () => {
    const reference = "OWNERSHIP/2026";
    const matter = await createMatter(reference);

    await allocate(matter, 1);

    const [ledger] = await testDb
      .select({
        workspaceId: documentReferenceCounters.workspaceId,
        lastValue: documentReferenceCounters.lastValue,
      })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, ids.orgA),
          eq(documentReferenceCounters.reference, reference),
        ),
      );

    expect(ledger).toEqual({ workspaceId: matter, lastValue: 1 });
  });
});

describe("matter read", () => {
  test("counts the live versions that already carry a stamp", async () => {
    const matter = await createMatter("STAMPED-COUNT/2026");
    const entityId = createSafeId<"entity">();
    await testDb.insert(entities).values({
      id: entityId,
      workspaceId: matter,
      kind: "document" as const,
      name: "Agreement",
    });
    await testDb.insert(entityVersions).values([
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 1,
        stamp: "STAMPED-COUNT/2026/001.v1",
      },
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 2,
        stamp: "STAMPED-COUNT/2026/001.v2",
        deletedAt: new Date(),
      },
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 3,
        stamp: null,
      },
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 4,
        stamp: "STAMPED-COUNT/2026/001/001.v4",
      },
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 5,
        stamp: "PREVIOUS-REFERENCE/001.v5",
      },
    ]);

    // A stamped version in a sibling matter must not be counted: the subquery
    // is correlated to the matter being read, not a table-wide aggregate.
    const sibling = await createMatter("STAMPED-COUNT-SIBLING/2026");
    const siblingEntityId = createSafeId<"entity">();
    await testDb.insert(entities).values({
      id: siblingEntityId,
      workspaceId: sibling,
      kind: "document" as const,
      name: "Sibling agreement",
    });
    await testDb.insert(entityVersions).values({
      id: createSafeId<"entityVersion">(),
      workspaceId: sibling,
      entityId: siblingEntityId,
      versionNumber: 1,
      stamp: "STAMPED-COUNT-SIBLING/2026/001.v1",
    });

    const { scopedDb } = scopeFor([matter]);
    const read = await readWorkspaceHandler({
      scopedDb,
      workspaceId: matter,
      organizationId: ids.orgA,
    });

    expect(read).toMatchObject({ stampedVersionCount: 1 });
  });
});

test("later issuance reserves its prefix while moved history keeps its original owner", async () => {
  const reference = "LATER-ISSUANCE/2026";
  const source = await createMatter(reference);
  const target = await createMatter("MOVED-HISTORY/2026");
  const staleOwner = await createMatter("STALE-ZERO-OWNER/2026");
  const zeroReference = "ZERO-LATER-ISSUANCE/2026";
  const zeroSource = await createMatter("ZERO-LATER-TEMP/2026");
  await testDb.insert(documentReferenceCounters).values({
    id: createSafeId<"documentReferenceCounter">(),
    organizationId: ids.orgA,
    reference: zeroReference,
    workspaceId: staleOwner,
    lastValue: 0,
  });
  await setReference(zeroSource, zeroReference);
  const sourceEntity = createSafeId<"entity">();
  const targetEntity = createSafeId<"entity">();
  const versions = [2, 3].map((versionNumber) => ({
    versionNumber,
    stamp: toDocumentReference({
      matterReference: reference,
      docSequence: 7,
      versionNumber,
    }),
  }));
  const { scopedDb } = scopeFor([source, target, zeroSource]);
  await scopedDb(async (tx) => {
    await tx.insert(entities).values([
      {
        id: sourceEntity,
        name: "Original document",
        workspaceId: source,
        kind: "document",
        docSequence: 7,
      },
      {
        id: targetEntity,
        name: "Moved document",
        workspaceId: target,
        kind: "document",
        docSequence: 1,
      },
    ]);
    await insertEntityVersions({
      tx,
      stampOrigin: "issued",
      values: versions.map((version) => ({
        ...version,
        workspaceId: source,
        entityId: sourceEntity,
      })),
    });
    await insertEntityVersions({
      tx,
      stampOrigin: "copied",
      values: versions.map((version) => ({
        ...version,
        workspaceId: target,
        entityId: targetEntity,
      })),
    });
    const zeroEntity = createSafeId<"entity">();
    await tx.insert(entities).values({
      id: zeroEntity,
      name: "Zero-value ledger document",
      workspaceId: zeroSource,
      kind: "document",
      docSequence: 4,
    });
    await insertEntityVersions({
      tx,
      stampOrigin: "issued",
      values: [
        {
          workspaceId: zeroSource,
          entityId: zeroEntity,
          versionNumber: 1,
          stamp: toDocumentReference({
            matterReference: zeroReference,
            docSequence: 4,
            versionNumber: 1,
          }),
        },
      ],
    });
  });

  const [ledger] = await testDb
    .select({
      workspaceId: documentReferenceCounters.workspaceId,
      lastValue: documentReferenceCounters.lastValue,
    })
    .from(documentReferenceCounters)
    .where(
      and(
        eq(documentReferenceCounters.organizationId, ids.orgA),
        eq(documentReferenceCounters.reference, reference),
      ),
    );
  expect(ledger).toEqual({ workspaceId: source, lastValue: 7 });
  expect((await allocate(source, 1)).at(0)?.docSequence).toBe(8);
  const copied = await testDb
    .select({ stamp: entityVersions.stamp })
    .from(entityVersions)
    .where(eq(entityVersions.entityId, targetEntity))
    .orderBy(entityVersions.versionNumber);
  expect(copied.map(({ stamp }) => stamp)).toEqual(
    versions.map(({ stamp }) => stamp),
  );
  const [zeroLedger] = await testDb
    .select({
      workspaceId: documentReferenceCounters.workspaceId,
      lastValue: documentReferenceCounters.lastValue,
    })
    .from(documentReferenceCounters)
    .where(
      and(
        eq(documentReferenceCounters.organizationId, ids.orgA),
        eq(documentReferenceCounters.reference, zeroReference),
      ),
    );
  expect(zeroLedger).toEqual({ workspaceId: zeroSource, lastValue: 4 });
});
