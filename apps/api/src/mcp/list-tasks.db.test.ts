import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityLinks,
  featureEnrolments,
  flowRuns,
  flowRunSteps,
  taskAssignees,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import listEntityLinks from "@/api/handlers/tasks/entity-links/list";
import readTaskById from "@/api/handlers/tasks/get";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { TASK_ASSIGNEE_FILTER } from "@/api/lib/tasks/assigned";
import { loadAccessibleMcpWorkspaces } from "@/api/mcp/context";
import type { McpRequestContext } from "@/api/mcp/context";
import { MATTER_TOOL_HANDLERS } from "@/api/mcp/matter-tools";
import { filterUsableMcpWorkspaces } from "@/api/mcp/workspace-session-scope";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

// Fixture membership (rls-helpers): userA1 belongs to wsA1 and wsA2 in org A
// and to wsB1 in org B; userA2 belongs to wsA2 only; userAdmin owns org A and
// belongs to no matter.
let testDb: TestDatabase;
let ids: TestIds;

const taskA1 = createSafeId<"entity">();
const taskA2Dated = createSafeId<"entity">();
const taskA2Undated = createSafeId<"entity">();
const taskB1 = createSafeId<"entity">();

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  await testDb.insert(entities).values([
    {
      id: taskA1,
      workspaceId: ids.wsA1,
      kind: "task",
      name: "A1 task",
      dueDate: "2026-03-01",
    },
    {
      id: taskA2Dated,
      workspaceId: ids.wsA2,
      kind: "task",
      name: "A2 dated task",
      dueDate: "2026-02-01",
    },
    {
      id: taskA2Undated,
      workspaceId: ids.wsA2,
      kind: "task",
      name: "A2 undated task",
    },
    {
      id: taskB1,
      workspaceId: ids.wsB1,
      kind: "task",
      name: "B1 task",
      dueDate: "2026-01-01",
    },
  ]);
  await testDb.insert(taskAssignees).values({
    id: createSafeId<"taskAssignee">(),
    workspaceId: ids.wsA1,
    entityId: taskA1,
    userId: ids.userA1,
    role: "assignee",
  });
});

afterAll(async () => {
  await releaseTestDb();
});

type ContextOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: MemberRole;
  /** Replace the membership-derived access map, as a token subset would. */
  accessibleWorkspaceIds?: SafeId<"workspace">[];
};

/**
 * The MCP request context `resolveMcpSessionContext` builds, over the PGlite
 * fixture: membership-mode RLS databases and the access map enumerated
 * through them.
 */
const createContext = async ({
  organizationId,
  userId,
  memberRole,
  accessibleWorkspaceIds,
}: ContextOptions): Promise<McpRequestContext> => {
  const identity = { organizationId, serverValidatedWorkspaceIds: [], userId };
  const scopedDb = asTestRaw<ScopedDb>(
    createMembershipScopedDb(testDb, identity),
  );
  const safeDb = asTestRaw<SafeDb>(createMembershipSafeDb(testDb, identity));
  const usable = filterUsableMcpWorkspaces({
    accessibleWorkspaces: await loadAccessibleMcpWorkspaces({
      organizationId,
      scopedDb,
    }),
    tokenWorkspaceIds: undefined,
  });
  const workspaceIds =
    accessibleWorkspaceIds ?? usable.map((workspace) => workspace.id);
  return asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: workspaceIds,
    accessibleWorkspaceIdSet: new Set(workspaceIds),
    accessibleWorkspaceStatusById: new Map(
      workspaceIds.map((id) => [id, "active"]),
    ),
    accessibleWorkspaces: usable,
    grantedScopes: [],
    memberRole,
    organizationId,
    recordAuditEvent: async () => undefined,
    safeDb,
    scopedDb,
    userId,
    userEmail: "standard@example.test",
  });
};

type ListedTask = { id: string; matterId: string };
type ListedPage = { tasks: ListedTask[]; nextCursor: string | null };

const listTasks = async (
  context: McpRequestContext,
  args: Record<string, unknown>,
): Promise<ListedPage> => {
  const response = await MATTER_TOOL_HANDLERS.list_tasks({ args, context });
  if (!("egress" in response) || !("tasks" in response.payload)) {
    throw new Error(`list_tasks did not list: ${JSON.stringify(response)}`);
  }
  return response.payload;
};

const listedIds = (page: ListedPage) => page.tasks.map((task) => task.id);

describe("list_tasks without matter_id", () => {
  test("a member sees only their own matters' tasks, never another matter's or firm's", async () => {
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userA2,
      memberRole: "member",
    });

    const page = await listTasks(context, {});

    // wsA1 is in the same firm but userA2 is not on it; wsB1 is another firm.
    expect(listedIds(page)).toEqual([taskA2Dated, taskA2Undated]);
  });

  test("a matter the user belongs to in another firm stays out of this firm's list", async () => {
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userA1,
      memberRole: "member",
    });

    const page = await listTasks(context, {});

    // userA1 is also on wsB1, but under org B: the active firm bounds the list.
    expect(listedIds(page)).toEqual([taskA2Dated, taskA1, taskA2Undated]);
    expect(page.tasks.map((task) => task.matterId)).toEqual([
      ids.wsA2,
      ids.wsA1,
      ids.wsA2,
    ]);
  });

  test("an owner sees the firm's client matters and no other firm's", async () => {
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userAdmin,
      memberRole: "owner",
    });

    const page = await listTasks(context, {});

    expect(listedIds(page)).toEqual([taskA2Dated, taskA1, taskA2Undated]);
  });

  test("a forged access map cannot widen what the database returns", async () => {
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userA2,
      memberRole: "member",
      accessibleWorkspaceIds: [ids.wsA1, ids.wsA2, ids.wsB1],
    });

    const page = await listTasks(context, {});

    expect(listedIds(page)).toEqual([taskA2Dated, taskA2Undated]);
  });

  test("an access map narrower than membership narrows the list", async () => {
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userA1,
      memberRole: "member",
      accessibleWorkspaceIds: [ids.wsA2],
    });

    const page = await listTasks(context, {});

    expect(listedIds(page)).toEqual([taskA2Dated, taskA2Undated]);
  });

  test("assignee 'me' keeps only the caller's assignments", async () => {
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userA1,
      memberRole: "member",
    });

    const page = await listTasks(context, {
      assignee: TASK_ASSIGNEE_FILTER.ME,
    });

    expect(listedIds(page)).toEqual([taskA1]);
  });

  test("cursor pages walk the full due-date order without gaps or repeats", async () => {
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userA1,
      memberRole: "member",
    });

    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ListedPage = await listTasks(context, {
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      });
      walked.push(...listedIds(page));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(walked).toEqual(listedIds(await listTasks(context, {})));
  });
});

describe("list_tasks with matter_id", () => {
  test("rejects a matter outside the caller's access map", async () => {
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userA2,
      memberRole: "member",
    });

    const response = await MATTER_TOOL_HANDLERS.list_tasks({
      args: { matter_id: ids.wsA1 },
      context,
    });

    expect(response).toMatchObject({
      status: "error",
      error: { code: "not_found" },
    });
  });
});

test("ordinary task detail omits related flow reviews after revoke in HTTP and MCP", async () => {
  const reviewId = createSafeId<"entity">();
  const ordinaryId = createSafeId<"entity">();
  const runId = createSafeId<"flowRun">();
  const identity = await testDb.query.user.findFirst({
    where: { id: { eq: ids.userA1 } },
    columns: { emailVerified: true },
  });
  if (identity === undefined) {
    return expect.unreachable("Missing member identity");
  }
  const grantWhere = and(
    eq(featureEnrolments.organizationId, ids.orgA),
    eq(featureEnrolments.userId, ids.userA1),
    eq(featureEnrolments.featureId, "flows"),
  );
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  try {
    await testDb.insert(entities).values([
      {
        id: reviewId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Hidden flow review",
        parentId: taskA1,
      },
      {
        id: ordinaryId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Ordinary child",
        parentId: taskA1,
      },
    ]);
    await testDb.insert(flowRuns).values({
      id: runId,
      workspaceId: ids.wsA1,
      definitionSnapshot: {
        name: "Review flow",
        steps: [
          {
            kind: "review-gate",
            name: "Review",
            instructions: "Review the draft",
          },
        ],
      },
      triggerSource: { type: "manual", userId: ids.userA1 },
      status: "awaiting_review",
      currentStepIndex: 0,
      startedAt: new Date(),
    });
    await testDb.insert(flowRunSteps).values({
      id: createSafeId<"flowRunStep">(),
      workspaceId: ids.wsA1,
      runId,
      index: 0,
      kind: "review-gate",
      status: "awaiting_review",
      reviewTaskEntityId: reviewId,
      startedAt: new Date(),
    });
    await testDb.insert(entityLinks).values([
      {
        id: createSafeId<"entityLink">(),
        workspaceId: ids.wsA1,
        sourceEntityId: reviewId,
        targetEntityId: taskA1,
      },
      {
        id: createSafeId<"entityLink">(),
        workspaceId: ids.wsA1,
        sourceEntityId: taskA1,
        targetEntityId: ordinaryId,
      },
    ]);
    const context = await createContext({
      organizationId: ids.orgA,
      userId: ids.userA1,
      memberRole: "member",
    });
    const httpContext = {
      safeDb: context.safeDb,
      scopedDb: context.scopedDb,
      user: { id: ids.userA1 },
      session: { activeOrganizationId: ids.orgA },
      workspaceId: ids.wsA1,
      params: { workspaceId: ids.wsA1, taskId: taskA1 },
      memberRole: sessionMemberRole("member"),
    };
    const readRelated = async () => {
      const detail = await readTaskById.handler(
        asTestRaw<Parameters<typeof readTaskById.handler>[0]>(httpContext),
      );
      if (!("children" in detail)) {
        return expect.unreachable(
          `Task read failed: ${JSON.stringify(detail)}`,
        );
      }
      const links = await listEntityLinks.handler(
        asTestRaw<Parameters<typeof listEntityLinks.handler>[0]>(httpContext),
      );
      if (!Array.isArray(links)) {
        return expect.unreachable(`Link read failed: ${JSON.stringify(links)}`);
      }
      const mcp = await MATTER_TOOL_HANDLERS.list_tasks({
        args: { task_id: taskA1 },
        context,
      });
      if (!("egress" in mcp) || !("task" in mcp.payload)) {
        return expect.unreachable(`MCP detail failed: ${JSON.stringify(mcp)}`);
      }
      return {
        children: detail.children.map(({ id }) => id),
        httpTargets: [
          ...detail.linksAsSource.map(({ targetEntityId }) => targetEntityId),
          ...detail.linksAsTarget.map(({ sourceEntityId }) => sourceEntityId),
        ],
        linkTargets: links.map(({ sourceEntityId, targetEntityId }) =>
          sourceEntityId === taskA1 ? targetEntityId : sourceEntityId,
        ),
        mcpTargets: mcp.payload.task.links.map(({ entity }) => entity.id),
      };
    };
    for (const enrolled of [false, true, false]) {
      if (enrolled) {
        await testDb.insert(featureEnrolments).values({
          organizationId: ids.orgA,
          userId: ids.userA1,
          featureId: "flows",
        });
      } else {
        await testDb.delete(featureEnrolments).where(grantWhere);
      }
      const related = await readRelated();
      for (const relatedIds of Object.values(related)) {
        expect(relatedIds).toContain(ordinaryId);
        expect(relatedIds.includes(reviewId)).toBe(enrolled);
      }
    }
    const hiddenRoot = await listEntityLinks.handler(
      asTestRaw<Parameters<typeof listEntityLinks.handler>[0]>({
        ...httpContext,
        params: { workspaceId: ids.wsA1, taskId: reviewId },
      }),
    );
    expect(hiddenRoot).toMatchObject({ code: 404 });
  } finally {
    await testDb.delete(featureEnrolments).where(grantWhere);
    await testDb.delete(flowRuns).where(eq(flowRuns.id, runId));
    await testDb
      .delete(entities)
      .where(inArray(entities.id, [reviewId, ordinaryId]));
    await testDb
      .update(user)
      .set({ emailVerified: identity.emailVerified })
      .where(eq(user.id, ids.userA1));
  }
});
