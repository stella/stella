import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamps } from "@/api/lib/document-counter";
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
  test("a matter taking over a freed reference continues its numbering", async () => {
    const handoverReference = "HANDOVER/2026";
    const matterA = await createMatter(handoverReference);

    const first = await allocate(matterA, 3);
    expect(first.map(({ stamp }) => stamp)).toEqual([
      `${handoverReference}/001.v1`,
      `${handoverReference}/002.v1`,
      `${handoverReference}/003.v1`,
    ]);

    // The reference is freed and handed to a brand-new matter, whose own
    // document counter starts at zero. Without the reference ledger the next
    // stamp would be HANDOVER/2026/001.v1 again.
    await setReference(matterA, "HANDOVER-RETIRED/2026");
    const matterB = await createMatter(handoverReference);

    const second = await allocate(matterB, 2);
    expect(second.map(({ stamp }) => stamp)).toEqual([
      `${handoverReference}/004.v1`,
      `${handoverReference}/005.v1`,
    ]);

    const stamps = [...first, ...second].map(({ stamp }) => stamp);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test("a matter returning to a reference it lent out does not repeat", async () => {
    const original = "ROUNDTRIP/2026";
    const interim = "ROUNDTRIP-INTERIM/2026";
    const borrower = "ROUNDTRIP-BORROWER/2026";
    const matter = await createMatter(original);
    const other = await createMatter(borrower);

    const before = await allocate(matter, 2);

    // The reference goes to another matter, which carries it further, and then
    // comes back. The original matter's own counter still stands at two, so
    // only the reference ledger can stop it from reissuing 003.
    await setReference(matter, interim);
    await setReference(other, original);
    const borrowed = await allocate(other, 2);
    await setReference(other, borrower);
    await setReference(matter, original);
    const after = await allocate(matter, 1);

    expect(before.map(({ stamp }) => stamp)).toEqual([
      `${original}/001.v1`,
      `${original}/002.v1`,
    ]);
    expect(borrowed.map(({ stamp }) => stamp)).toEqual([
      `${original}/003.v1`,
      `${original}/004.v1`,
    ]);
    expect(after.map(({ stamp }) => stamp)).toEqual([`${original}/005.v1`]);

    const stamps = [...before, ...borrowed, ...after].map(({ stamp }) => stamp);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  // PGlite drives one single-threaded connection, so two transactions cannot
  // genuinely overlap here; this asserts the observable invariant instead —
  // separate transactions allocating under a shared reference from different
  // matters receive disjoint, strictly increasing blocks, which is what the
  // ledger's `FOR UPDATE` serialization has to produce.
  test("separate transactions under one reference receive disjoint blocks", async () => {
    const shared = "SHARED/2026";
    const matterA = await createMatter(shared);
    const matterB = await createMatter("SHARED-OTHER/2026");

    const blockA = await allocate(matterA, 2);
    await setReference(matterA, "SHARED-RETIRED/2026");
    await setReference(matterB, shared);
    const blockB = await allocate(matterB, 2);

    const sequences = [...blockA, ...blockB].map(
      ({ docSequence }) => docSequence,
    );
    expect(sequences).toEqual([1, 2, 3, 4]);
    const stamps = [...blockA, ...blockB].map(({ stamp }) => stamp);
    expect(new Set(stamps).size).toBe(stamps.length);
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
  test("reports where numbering continues when the reference is in use", async () => {
    const takenOver = "TAKEOVER/2026";
    const donor = await createMatter(takenOver);
    await allocate(donor, 4);
    await setReference(donor, "TAKEOVER-RETIRED/2026");

    const receiver = await createMatter("RECEIVER/2026");
    const { safeDb } = scopeFor([receiver]);
    const updated = await Result.gen(() =>
      updateWorkspaceHandler({
        safeDb,
        organizationId: ids.orgA,
        workspaceId: receiver,
        recordAuditEvent,
        body: { reference: takenOver },
      }),
    );

    expect(Result.isOk(updated)).toBe(true);
    expect(Result.isOk(updated) && updated.value).toEqual({
      referenceNumberingContinuesFrom: 5,
    });
  });

  test("reports the matter's own counter when it is ahead of the reference", async () => {
    const takenOver = "AHEAD/2026";
    const donor = await createMatter(takenOver);
    await allocate(donor, 2);
    await setReference(donor, "AHEAD-RETIRED/2026");

    // The receiver has already stamped five documents under its own
    // reference, so allocation floors at its counter, not at the ledger's 2.
    const receiver = await createMatter("AHEAD-RECEIVER/2026");
    await allocate(receiver, 5);

    const { safeDb } = scopeFor([receiver]);
    const updated = await Result.gen(() =>
      updateWorkspaceHandler({
        safeDb,
        organizationId: ids.orgA,
        workspaceId: receiver,
        recordAuditEvent,
        body: { reference: takenOver },
      }),
    );

    expect(Result.isOk(updated) && updated.value).toEqual({
      referenceNumberingContinuesFrom: 6,
    });

    const next = await allocate(receiver, 1);
    expect(next.map(({ stamp }) => stamp)).toEqual([`${takenOver}/006.v1`]);
  });

  test("reports no continuation for a reference nothing has stamped", async () => {
    const matter = await createMatter("FRESH-BEFORE/2026");
    const { safeDb } = scopeFor([matter]);

    const updated = await Result.gen(() =>
      updateWorkspaceHandler({
        safeDb,
        organizationId: ids.orgA,
        workspaceId: matter,
        recordAuditEvent,
        body: { reference: "FRESH-AFTER/2026" },
      }),
    );

    expect(Result.isOk(updated) && updated.value).toEqual({
      referenceNumberingContinuesFrom: null,
    });
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
