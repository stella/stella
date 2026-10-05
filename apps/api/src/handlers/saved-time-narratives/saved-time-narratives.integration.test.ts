import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import { savedTimeNarratives, featureEnrolments } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { brandPersistedSavedTimeNarrativeId } from "@/api/lib/safe-id-boundaries";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createSavedTimeNarrative from "./create";
import deleteSavedTimeNarrative from "./delete";
import listSavedTimeNarratives from "./list";
import updateSavedTimeNarrative from "./update";

type CreateCtx = Parameters<typeof createSavedTimeNarrative.handler>[0];
type ListCtx = Parameters<typeof listSavedTimeNarratives.handler>[0];
type UpdateCtx = Parameters<typeof updateSavedTimeNarrative.handler>[0];
type DeleteCtx = Parameters<typeof deleteSavedTimeNarrative.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
const auditEvents: AuditEvent[] = [];
const createdIds: SafeId<"savedTimeNarrative">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1, ids.userA2]));
  await testDb
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgA,
        userId: ids.userA2,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgB,
        userId: ids.userA1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  try {
    if (createdIds.length > 0) {
      await testDb
        .delete(savedTimeNarratives)
        .where(inArray(savedTimeNarratives.id, createdIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const context = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) => ({
  safeDb: createSafeDb(testDb, [], organizationId, userId),
  scopedDb: createScopedDb(testDb, [], organizationId, userId),
  session: { activeOrganizationId: organizationId },
  user: { id: userId },
  memberRole: sessionMemberRole("owner"),
  recordAuditEvent: async (_tx: unknown, event: AuditEvent | AuditEvent[]) => {
    auditEvents.push(...(Array.isArray(event) ? event : [event]));
  },
  request: new Request("https://example.test/saved-time-narratives"),
  route: "/test/saved-time-narratives",
});

test("saved narrative CRUD stays personal and scoped to the active organization", async () => {
  const owner = context(ids.orgA, ids.userA1);
  const created = await createSavedTimeNarrative.handler(
    asTestRaw<CreateCtx>({
      ...owner,
      body: {
        name: "Drafting",
        narrative: "Reviewed motion",
        narrativeLanguage: "cs-CZ",
      },
    }),
  );
  expect(created).toMatchObject({
    name: "Drafting",
    narrative: "Reviewed motion",
    narrativeLanguage: "cs-CZ",
  });
  if (!("id" in created)) {
    throw new Error("Create did not return an id");
  }
  const id = brandPersistedSavedTimeNarrativeId(created.id);
  createdIds.push(id);

  const list = async (
    organizationId: SafeId<"organization">,
    userId: SafeId<"user">,
  ) =>
    await listSavedTimeNarratives.handler(
      asTestRaw<ListCtx>({
        ...context(organizationId, userId),
        query: { limit: 10 },
      }),
    );
  expect(await list(ids.orgA, ids.userA1)).toMatchObject({
    items: [{ id, narrativeLanguage: "cs-CZ" }],
  });
  expect(await list(ids.orgA, ids.userA2)).toMatchObject({ items: [] });
  expect(await list(ids.orgB, ids.userA1)).toMatchObject({ items: [] });

  const foreignUpdate = await updateSavedTimeNarrative.handler(
    asTestRaw<UpdateCtx>({
      ...context(ids.orgA, ids.userA2),
      params: { id },
      body: { name: "Changed" },
    }),
  );
  expect(foreignUpdate).toMatchObject({ code: 404 });
  const updated = await updateSavedTimeNarrative.handler(
    asTestRaw<UpdateCtx>({
      ...owner,
      params: { id },
      body: { narrative: "Edited motion", narrativeLanguage: null },
    }),
  );
  expect(updated).toMatchObject({
    narrative: "Edited motion",
    narrativeLanguage: null,
  });
  const foreignDelete = await deleteSavedTimeNarrative.handler(
    asTestRaw<DeleteCtx>({
      ...context(ids.orgB, ids.userA1),
      params: { id },
    }),
  );
  expect(foreignDelete).toMatchObject({ code: 404 });
  const deleted = await deleteSavedTimeNarrative.handler(
    asTestRaw<DeleteCtx>({
      ...owner,
      params: { id },
    }),
  );
  expect(deleted).toEqual({ id });
  expect(await list(ids.orgA, ids.userA1)).toMatchObject({ items: [] });
  expect(JSON.stringify(auditEvents)).not.toContain("Reviewed motion");
  expect(JSON.stringify(auditEvents)).not.toContain("Edited motion");
});

test("blank names and narratives are rejected before persistence", async () => {
  const result = await createSavedTimeNarrative.handler(
    asTestRaw<CreateCtx>({
      ...context(ids.orgA, ids.userA1),
      body: { name: "   ", narrative: "Valid", narrativeLanguage: null },
    }),
  );
  expect(result).toMatchObject({ code: 400 });
  const rows = await testDb
    .select({ id: savedTimeNarratives.id })
    .from(savedTimeNarratives)
    .where(
      and(
        eq(savedTimeNarratives.organizationId, ids.orgA),
        eq(savedTimeNarratives.userId, ids.userA1),
        eq(savedTimeNarratives.name, "   "),
      ),
    );
  expect(rows).toEqual([]);
});

test("saved narratives stop at the per-user limit", async () => {
  const rows = Array.from(
    { length: LIMITS.savedTimeNarrativesPerUser },
    (_, index) => ({
      id: createSafeId<"savedTimeNarrative">(),
      organizationId: ids.orgA,
      userId: ids.userA1,
      name: `Template ${index}`,
      narrative: "Reusable text",
    }),
  );
  await testDb.insert(savedTimeNarratives).values(rows);
  createdIds.push(...rows.map(({ id }) => id));

  const result = await createSavedTimeNarrative.handler(
    asTestRaw<CreateCtx>({
      ...context(ids.orgA, ids.userA1),
      body: { name: "Over limit", narrative: "More text" },
    }),
  );
  expect(result).toMatchObject({
    code: 400,
    response: { message: "Saved time narrative limit reached" },
  });
});
