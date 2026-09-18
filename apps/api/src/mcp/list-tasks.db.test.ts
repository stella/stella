import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { entities, taskAssignees } from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import { TASK_ASSIGNEE_FILTER } from "@/api/handlers/tasks/list-query";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
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
