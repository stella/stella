import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { createScopedDb } from "@/api/db/scoped";
import {
  bindApprovedMcpAuditContext,
  loadAccessibleMcpWorkspaces,
} from "@/api/mcp/context";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

setDefaultTimeout(120_000);

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("MCP workspace enumeration", () => {
  test("keeps the organization predicate when RLS allows cross-org explicit IDs", async () => {
    const explicitScope = createScopedDb(
      testDb,
      [ids.wsA1, ids.wsB1],
      ids.orgA,
      ids.userA1,
    );

    const workspaces = await loadAccessibleMcpWorkspaces({
      organizationId: ids.orgA,
      scopedDb: asTestRaw<ScopedDb>(explicitScope),
    });

    expect(workspaces.map((workspace) => workspace.id)).toEqual([ids.wsA1]);
  });
});

describe("MCP audit approval", () => {
  test("binds confirmed execution to the authenticated approver", async () => {
    let inserted: Record<string, unknown>[] = [];
    const context = asTestRaw<McpRequestContext>({
      auditExecution: {
        performer: { id: "agent-1", name: "Agent 1", type: "agent" },
        runId: "run-1",
        trigger: {
          ownerUserId: ids.userA1,
          source: "mcp",
          type: "credential",
        },
      },
      organizationId: ids.orgA,
      request: new Request("http://localhost/mcp"),
      userId: ids.userA1,
    });
    const approvedContext = bindApprovedMcpAuditContext(context);
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });

    await approvedContext.recordAuditEvent(tx, {
      action: "delete",
      resourceId: "entity-1",
      resourceType: "entity",
    });

    expect(inserted[0]).toMatchObject({
      approvalStatus: "approved",
      approvedByUserId: ids.userA1,
      performerId: "agent-1",
      performerType: "agent",
      runId: "run-1",
      triggerSource: "mcp",
      triggerType: "credential",
    });
  });
});
