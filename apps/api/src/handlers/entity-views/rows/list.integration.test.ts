import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract/entity-options";
import {
  ENTITY_VIEW_ROW_KIND,
  ENTITY_VIEW_WORK_RISK,
} from "@stll/api-contract/entity-views";
import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
  SIGNAL_VIEW,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import type { SignalView } from "@stll/api-contract/signals";

import {
  entities,
  entityVersions,
  signals,
  WORK_OBLIGATION_STATUS,
  workObligations,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import listRows from "@/api/handlers/entity-views/rows/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type RowsContext = Parameters<typeof listRows.handler>[0];
type RowsBody = RowsContext["body"];

const AS_OF = "2026-02-01";
const TASKS_ONLY: NonNullable<RowsBody["filters"]> = [
  {
    type: "predicate",
    operand: { type: "kind" },
    op: "in",
    value: ["task"],
  },
];
const DUE_SOONEST: NonNullable<RowsBody["sorts"]> = [
  { propertyId: "_due-date", desc: false },
];

let testDb: TestDatabase;
let ids: TestIds;
const seededEntities: SafeId<"entity">[] = [];
const seededSignals: SafeId<"signal">[] = [];
const labels = new Map<string, string>();

type SeedTaskOptions = {
  label: string;
  workspaceId: SafeId<"workspace">;
  dueDate: string;
  status?: string;
};

const seedTask = async ({
  label,
  workspaceId,
  dueDate,
  status = TASK_STATUS.OPEN,
}: SeedTaskOptions) => {
  const id = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  await testDb.insert(entities).values({
    id,
    workspaceId,
    kind: "task",
    name: label,
    status,
    dueDate,
  });
  await testDb
    .insert(entityVersions)
    .values({ id: versionId, workspaceId, entityId: id });
  await testDb
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(inArray(entities.id, [id]));
  seededEntities.push(id);
  labels.set(id, label);
  return id;
};

type SeedSignalOptions = {
  label: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  /** A task proposal due that day, or none. */
  dueAt: string | null;
  proposes?:
    | typeof SUGGESTION_KIND.CREATE_TASK
    | typeof SUGGESTION_KIND.CREATE_DEADLINE;
};

const seedSignal = async ({
  label,
  organizationId,
  workspaceId,
  dueAt,
  proposes = SUGGESTION_KIND.CREATE_TASK,
}: SeedSignalOptions) => {
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
    title: label,
    summary: label,
    subject: workspaceId
      ? { type: "workspace", workspaceId }
      : { type: "none" },
    evidence: {
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      description: label,
      attachments: [],
    },
    suggestions:
      workspaceId && dueAt
        ? [
            {
              kind: proposes,
              workspaceId,
              name: label,
              dueAt,
            },
          ]
        : [],
    dedupeKey: `test:${id}`,
  });
  seededSignals.push(id);
  labels.set(id, label);
  return id;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const atRiskTask = await seedTask({
    label: "task A1",
    workspaceId: ids.wsA1,
    dueDate: "2026-01-01",
  });
  await seedTask({
    label: "task A1 tied",
    workspaceId: ids.wsA1,
    dueDate: "2026-01-03",
  });
  await seedTask({
    label: "task A1 done",
    workspaceId: ids.wsA1,
    dueDate: "2026-01-02",
    status: TASK_STATUS.DONE,
  });
  await seedTask({
    label: "task A2",
    workspaceId: ids.wsA2,
    dueDate: "2026-01-05",
  });
  await seedTask({
    label: "task B1",
    workspaceId: ids.wsB1,
    dueDate: "2026-01-01",
  });
  await seedSignal({
    label: "signal A1",
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    dueAt: "2026-01-03",
  });
  await seedSignal({
    label: "signal A2",
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    dueAt: "2026-01-04T09:00:00.000Z",
  });
  await seedSignal({
    label: "signal A1 deadline",
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    dueAt: "2026-01-06",
    proposes: SUGGESTION_KIND.CREATE_DEADLINE,
  });
  await seedSignal({
    label: "signal unscoped",
    organizationId: ids.orgA,
    workspaceId: null,
    dueAt: null,
  });
  await seedSignal({
    label: "signal B1",
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    dueAt: "2026-01-01",
  });
  await testDb.insert(workObligations).values({
    entityId: atRiskTask,
    workspaceId: ids.wsA1,
    ownerUserId: ids.userA1,
    status: WORK_OBLIGATION_STATUS.ACTIVE,
    acknowledgedAt: new Date(),
    acknowledgedByUserId: ids.userA1,
    workingTargetDate: null,
    hardDeadlineDate: "2026-01-01",
    createdByUserId: ids.userA1,
  });
});

afterAll(async () => {
  try {
    if (seededSignals.length > 0) {
      await testDb.delete(signals).where(inArray(signals.id, seededSignals));
    }
    if (seededEntities.length > 0) {
      await testDb.delete(entities).where(inArray(entities.id, seededEntities));
    }
  } finally {
    await releaseRlsFixture();
  }
});

type ReadWindowOptions = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  workspaceIds: SafeId<"workspace">[];
  role: RowsContext["memberRole"]["role"];
  body: Partial<RowsBody>;
};

const readWindow = async ({
  userId,
  organizationId,
  workspaceIds,
  role,
  body,
}: ReadWindowOptions) => {
  const result = await listRows.handler(
    asTestRaw<RowsContext>({
      getActiveWorkspaceIds: async () => workspaceIds,
      getAccessibleWorkspaces: async () =>
        workspaceIds.map((id) => ({ id, status: "active" })),
      getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
        workspaceIds.includes(workspaceId)
          ? { id: workspaceId, status: "active" }
          : null,
      memberRole: { role },
      request: new Request("https://example.test/entity-views/query-window"),
      route: "/test/entity-views/query-window",
      safeDb: createSafeDb(testDb, workspaceIds, organizationId, userId),
      scopedDb: createScopedDb(testDb, workspaceIds, organizationId, userId),
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      body: { scope: { type: "organization" }, ...body },
    }),
  );
  if (!("items" in result)) {
    return expect.unreachable(`window failed: ${JSON.stringify(result)}`);
  }
  return result;
};

const rowId = (row: Awaited<ReturnType<typeof readWindow>>["items"][number]) =>
  row.kind === ENTITY_VIEW_ROW_KIND.ENTITY
    ? row.entity.entityId
    : row.signal.id;

/** The seeded rows a page holds, by label, in page order. */
const seededLabels = (page: Awaited<ReturnType<typeof readWindow>>) =>
  page.items.flatMap((row) => {
    const label = labels.get(rowId(row));
    return label === undefined ? [] : [label];
  });

type ReadInboxOptions = {
  view?: SignalView;
  userId?: SafeId<"user">;
  organizationId?: SafeId<"organization">;
  workspaceIds?: SafeId<"workspace">[];
  role?: RowsContext["memberRole"]["role"];
  body?: Partial<RowsBody>;
};

const readInbox = async ({
  view = SIGNAL_VIEW.OPEN,
  userId = ids.userA1,
  organizationId = ids.orgA,
  workspaceIds = [ids.wsA1, ids.wsA2, ids.wsB1],
  role = "owner",
  body = {},
}: ReadInboxOptions = {}) =>
  await readWindow({
    userId,
    organizationId,
    workspaceIds,
    role,
    body: {
      filters: TASKS_ONLY,
      sorts: DUE_SOONEST,
      inboxView: view,
      asOf: AS_OF,
      limit: 100,
      ...body,
    },
  });

describe("Inbox window: entities and signals in one result set", () => {
  test("orders both kinds by the view sort, entities before signals on a tie", async () => {
    expect(seededLabels(await readInbox())).toEqual([
      "task A1",
      "task A1 tied",
      "signal A1",
      "signal A2",
      "task A2",
      "signal A1 deadline",
    ]);
  });

  test("keyset paging across kinds has no gaps or duplicates", async () => {
    const whole = await readInbox();
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const next = await readInbox({
        body: { limit: 1, ...(cursor === undefined ? {} : { cursor }) },
      });
      walked.push(...next.items.map(rowId));
      if (next.nextCursor === null) {
        break;
      }
      cursor = next.nextCursor;
    }
    expect(walked).toEqual(whole.items.map(rowId));
    expect(new Set(walked).size).toBe(walked.length);
  });

  test("a matter the caller is not a member of contributes no task or signal", async () => {
    expect(
      seededLabels(
        await readInbox({
          userId: ids.userA2,
          workspaceIds: [ids.wsA2],
          role: "member",
        }),
      ),
    ).toEqual(["signal A2", "task A2"]);
  });

  test("another organization's tasks and signals never appear, even for a member of both", async () => {
    // userA1 also belongs to wsB1 in orgB; the orgA session must not reach it.
    const labelsInA = seededLabels(await readInbox({ body: { filters: [] } }));
    expect(labelsInA).not.toContain("task B1");
    expect(labelsInA).not.toContain("signal B1");
    expect(
      seededLabels(
        await readInbox({
          userId: ids.userB1,
          organizationId: ids.orgB,
          workspaceIds: [ids.wsB1],
        }),
      ),
    ).toEqual(["task B1", "signal B1"]);
  });

  test("a matter scope narrows both kinds", async () => {
    expect(
      seededLabels(
        await readInbox({
          body: { scope: { type: "matter", matterId: ids.wsA1 } },
        }),
      ),
    ).toEqual(["task A1", "task A1 tied", "signal A1", "signal A1 deadline"]);
  });

  test("unscoped signals need triage and have no task kind", async () => {
    const all = await readInbox({ body: { filters: [] } });
    expect(seededLabels(all)).toContain("signal unscoped");
    expect(
      seededLabels(await readInbox({ body: { filters: [] }, role: "intern" })),
    ).not.toContain("signal unscoped");
    expect(seededLabels(await readInbox())).not.toContain("signal unscoped");
  });

  test("a type filter matches the work a signal proposes", async () => {
    const onlyDeadlines = await readInbox({
      body: {
        filters: [
          ...TASKS_ONLY,
          {
            type: "predicate",
            operand: { type: "builtin", field: "agendaKind" },
            op: "in",
            value: ["deadline"],
          },
        ],
      },
    });
    expect(seededLabels(onlyDeadlines)).toEqual(["signal A1 deadline"]);
    const deadline = onlyDeadlines.items.find(
      (row) => labels.get(rowId(row)) === "signal A1 deadline",
    );
    expect(
      deadline?.kind === ENTITY_VIEW_ROW_KIND.SIGNAL
        ? deadline.projection
        : null,
    ).toEqual({
      kind: "task",
      status: TASK_STATUS.OPEN,
      agendaKind: "deadline",
      dueDate: "2026-01-06",
    });
  });

  test("resolved holds finished tasks; snoozed holds no tasks", async () => {
    expect(
      seededLabels(await readInbox({ view: SIGNAL_VIEW.RESOLVED })),
    ).toEqual(["task A1 done"]);
    expect(
      seededLabels(await readInbox({ view: SIGNAL_VIEW.SNOOZED })),
    ).toEqual([]);
  });

  test("task rows carry the shared at-risk predicate", async () => {
    const page = await readInbox();
    const risks = new Map(
      page.items.flatMap((row) =>
        row.kind === ENTITY_VIEW_ROW_KIND.ENTITY
          ? [[labels.get(row.entity.entityId), row.workRisk] as const]
          : [],
      ),
    );
    expect(risks.get("task A1")).toBe(ENTITY_VIEW_WORK_RISK.AT_RISK);
    expect(risks.get("task A2")).toBe(ENTITY_VIEW_WORK_RISK.NONE);
  });

  test("without inboxView the window holds entities only", async () => {
    const page = await readWindow({
      userId: ids.userA1,
      organizationId: ids.orgA,
      workspaceIds: [ids.wsA1, ids.wsA2],
      role: "owner",
      body: { filters: TASKS_ONLY, sorts: DUE_SOONEST, limit: 100 },
    });
    expect(
      page.items.every((row) => row.kind === ENTITY_VIEW_ROW_KIND.ENTITY),
    ).toBe(true);
    expect(seededLabels(page)).toContain("task A1 done");
  });
});
