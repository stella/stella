import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import {
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";

import { signals } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import listSignals from "@/api/handlers/signals/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
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
  await seedSignal({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    title: "scoped A1",
  });
  await seedSignal({
    organizationId: ids.orgA,
    workspaceId: null,
    title: "unscoped A",
  });
  await seedSignal({
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    title: "scoped B1",
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

const listAs = async ({
  userId,
  organizationId,
  workspaceIds,
  role,
}: {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  workspaceIds: SafeId<"workspace">[];
  role: ListContext["memberRole"]["role"];
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
      query: {},
      route: "/test/signals",
    }),
  );
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
});
