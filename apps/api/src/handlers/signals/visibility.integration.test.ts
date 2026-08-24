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

import {
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";

import { SIGNAL_EVENT_TYPE, signalEvents, signals } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import listSignals from "@/api/handlers/signals/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { SCOUT_KEY } from "@/api/lib/signals/scout";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type ListContext = Parameters<typeof listSignals.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
const seeded: SafeId<"signal">[] = [];
let unscopedSignalA: SafeId<"signal"> | null = null;
let scopedSignalA1: SafeId<"signal"> | null = null;

const seedSignal = async ({
  organizationId,
  workspaceId,
  title,
}: {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  title: string;
}) => {
  const id = createSafeId<"signal">();
  await testDb.insert(signals).values({
    id,
    organizationId,
    workspaceId,
    kind: SIGNAL_KIND.REQUEST_SUBMITTED,
    origin: SIGNAL_KIND_ORIGIN[SIGNAL_KIND.REQUEST_SUBMITTED],
    scoutKey: SCOUT_KEY.MANUAL_REQUEST,
    severity: SIGNAL_SEVERITY.NOTICE,
    confidence: null,
    title,
    summary: title,
    subject: workspaceId
      ? { type: "workspace", workspaceId }
      : { type: "none" },
    evidence: {
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      description: title,
      attachments: [],
    },
    suggestions: [],
    dedupeKey: `test:${id}`,
  });
  seeded.push(id);
  return id;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const seededScopedSignalA1 = await seedSignal({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    title: "scoped A1",
  });
  scopedSignalA1 = seededScopedSignalA1;
  unscopedSignalA = await seedSignal({
    organizationId: ids.orgA,
    workspaceId: null,
    title: "unscoped A",
  });
  await seedSignal({
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    title: "scoped B1",
  });
  await testDb.insert(signalEvents).values({
    id: createSafeId<"signalEvent">(),
    organizationId: ids.orgA,
    signalId: seededScopedSignalA1,
    type: SIGNAL_EVENT_TYPE.CREATED,
  });
});

afterAll(async () => {
  try {
    if (seeded.length > 0) {
      await testDb.delete(signals).where(inArray(signals.id, seeded));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const runListAs = async ({
  userId,
  organizationId,
  workspaceIds,
  role,
  query = {},
}: {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  workspaceIds: SafeId<"workspace">[];
  role: ListContext["memberRole"]["role"];
  query?: ListContext["query"];
}) => {
  const scopedDb = createScopedDb(testDb, workspaceIds, organizationId, userId);
  const safeDb = createSafeDb(testDb, workspaceIds, organizationId, userId);
  const recordAuditEvent: ListContext["recordAuditEvent"] = async () =>
    undefined;
  const result = await listSignals.handler(
    asTestRaw<ListContext>({
      getActiveWorkspaceIds: async () => workspaceIds,
      getAccessibleWorkspaces: async () =>
        workspaceIds.map((id) => ({ id, status: "active" })),
      getWorkspaceAccess: async () => null,
      createAuditRecorder: () => recordAuditEvent,
      memberRole: { role },
      orgAIConfig: null,
      promptCachingEnabled: false,
      recordAuditEvent,
      request: new Request("https://example.test/signals"),
      safeDb,
      scopedDb,
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      query,
      route: "/test/signals",
    }),
  );
  return result;
};

const listAs = async (args: Parameters<typeof runListAs>[0]) => {
  const result = await runListAs(args);
  if (!("items" in result)) {
    throw new Error(`unexpected list result: ${JSON.stringify(result)}`);
  }
  return result.items.map((item) => item.title).sort();
};

describe("signal visibility", () => {
  test("a member sees scoped signals only for workspaces they can access", async () => {
    // userA2 is a member of wsA2 only; wsA1's signal must stay hidden.
    expect(
      await listAs({
        userId: ids.userA2,
        organizationId: ids.orgA,
        workspaceIds: [ids.wsA2],
        role: "owner",
      }),
    ).toEqual(["unscoped A"]);
  });

  test("unscoped signals need the triage permission", async () => {
    expect(
      await listAs({
        userId: ids.userA1,
        organizationId: ids.orgA,
        workspaceIds: [ids.wsA1],
        role: "intern",
      }),
    ).toEqual(["scoped A1"]);
    expect(
      await listAs({
        userId: ids.userA1,
        organizationId: ids.orgA,
        workspaceIds: [ids.wsA1],
        role: "owner",
      }),
    ).toEqual(["scoped A1", "unscoped A"]);
  });

  test("a hidden unscoped signal cannot be used as a pagination cursor", async () => {
    expect(unscopedSignalA).not.toBeNull();
    if (!unscopedSignalA) {
      throw new Error("Expected the unscoped signal fixture");
    }
    const result = await runListAs({
      userId: ids.userA1,
      organizationId: ids.orgA,
      workspaceIds: [ids.wsA1],
      role: "intern",
      query: { cursor: encodePaginationCursor([unscopedSignalA]) },
    });
    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid cursor" },
    });
  });

  test("another organization's signals never leak", async () => {
    expect(
      await listAs({
        userId: ids.userB1,
        organizationId: ids.orgB,
        workspaceIds: [ids.wsB1],
        role: "owner",
      }),
    ).toEqual(["scoped B1"]);
  });

  test("signal events inherit their parent signal's workspace visibility", async () => {
    const signalId = scopedSignalA1;
    expect(signalId).not.toBeNull();
    if (!signalId) {
      throw new Error("Expected the scoped signal fixture");
    }

    const countVisibleToA2 = await createScopedDb(
      testDb,
      [ids.wsA2],
      ids.orgA,
      ids.userA2,
    )(
      async (tx) =>
        await tx.$count(signalEvents, eq(signalEvents.signalId, signalId)),
    );
    expect(countVisibleToA2).toBe(0);

    const hiddenParentInsert = await Result.tryPromise(
      async () =>
        await createScopedDb(
          testDb,
          [ids.wsA2],
          ids.orgA,
          ids.userA2,
        )(async (tx) => {
          await tx.insert(signalEvents).values({
            id: createSafeId<"signalEvent">(),
            organizationId: ids.orgA,
            signalId,
            type: SIGNAL_EVENT_TYPE.CREATED,
          });
        }),
    );
    expect(Result.isError(hiddenParentInsert)).toBe(true);

    await createScopedDb(
      testDb,
      [ids.wsA1],
      ids.orgA,
      ids.userA1,
    )(async (tx) => {
      await tx.insert(signalEvents).values({
        id: createSafeId<"signalEvent">(),
        organizationId: ids.orgA,
        signalId,
        type: SIGNAL_EVENT_TYPE.ASSIGNED,
      });
    });

    const countVisibleToA1 = await createScopedDb(
      testDb,
      [ids.wsA1],
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await tx.$count(signalEvents, eq(signalEvents.signalId, signalId)),
    );
    expect(countVisibleToA1).toBe(2);
  });
});
