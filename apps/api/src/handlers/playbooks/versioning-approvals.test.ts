import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { playbookDefinitions } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import approvePlaybookDefinition from "@/api/handlers/playbooks/approve";
import createPlaybookDefinition from "@/api/handlers/playbooks/create";
import listPlaybookVersions from "@/api/handlers/playbooks/list-versions";
import restorePlaybookVersion from "@/api/handlers/playbooks/restore-version";
import updatePlaybookDefinition from "@/api/handlers/playbooks/update";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

// Every handler under test here is root-scoped: it reads the acting org from
// `session.activeOrganizationId` and goes through `safeDb` (RLS role
// `stella`). Driven against the real pglite harness with two orgs, exactly
// like the document-types and from-starter write-handler suites, so ownership
// and cross-tenant isolation are exercised for real.

let testDb: TestDatabase;
let ids: TestIds;

const noopAuditRecorder: AuditRecorder = async () => undefined;

type OrgContext = ReturnType<typeof createOrgContext>;

const createOrgContext = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) => {
  const safeDb = createSafeDb(testDb, [], organizationId, userId);

  return {
    createAuditRecorder: () => noopAuditRecorder,
    memberRole: { role: "owner" as const },
    orgAIConfig: null,
    promptCachingEnabled: false,
    recordAuditEvent: noopAuditRecorder,
    request: new Request("https://example.test/playbooks"),
    route: "/playbooks",
    safeDb,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
  };
};

// The exported `.handler` returns the *unwrapped* success payload on ok, or an
// Elysia status response (`{ code, ... }`) on error — not a raw Result.
type TestEndpoint<TContext> = {
  handler: (context: TContext) => Promise<unknown>;
};

const runHandler = async <TContext>(
  endpoint: TestEndpoint<TContext>,
  context: OrgContext,
  requestShape: Record<string, unknown>,
): Promise<unknown> => {
  try {
    return await endpoint.handler(
      asTestRaw<TContext>({ ...context, ...requestShape }),
    );
  } catch (error) {
    return error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getStatusCode = (result: unknown): number | null => {
  if (!isRecord(result)) {
    return null;
  }
  for (const field of ["status", "statusCode", "code"] as const) {
    if (typeof result[field] === "number") {
      return result[field];
    }
  }
  return null;
};

const createPlaybook = async (
  context: OrgContext,
  name: string,
): Promise<SafeId<"playbookDefinition">> => {
  const result = await runHandler(createPlaybookDefinition, context, {
    body: { name, positions: { version: 2, items: [] } },
  });
  expect(getStatusCode(result)).toBeNull();
  if (!isRecord(result) || typeof result["id"] !== "string") {
    throw new Error("Expected a created-playbook payload ({ id })");
  }
  return toSafeId<"playbookDefinition">(result["id"]);
};

type PlaybookRow = {
  status: string;
  approvedAt: Date | null;
  approvedBy: string | null;
  name: string;
};

const readPlaybook = async (
  playbookId: SafeId<"playbookDefinition">,
): Promise<PlaybookRow | undefined> =>
  (
    await testDb
      .select({
        status: playbookDefinitions.status,
        approvedAt: playbookDefinitions.approvedAt,
        approvedBy: playbookDefinitions.approvedBy,
        name: playbookDefinitions.name,
      })
      .from(playbookDefinitions)
      .where(eq(playbookDefinitions.id, playbookId))
  ).at(0);

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await releaseTestDb();
});

describe("POST /playbooks/:playbookId/approve", () => {
  test("snapshots version 1, then version 2 on re-approve; flips status to approved", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const playbookId = await createPlaybook(context, "Approve me");

    const firstApproval = await runHandler(approvePlaybookDefinition, context, {
      params: { playbookId },
    });
    expect(getStatusCode(firstApproval)).toBeNull();
    if (!isRecord(firstApproval)) {
      throw new Error("Expected an approve payload");
    }
    expect(firstApproval["status"]).toBe("approved");
    expect(firstApproval["version"]).toBe(1);
    expect(typeof firstApproval["approvedAt"]).toBe("string");

    const afterFirst = await readPlaybook(playbookId);
    expect(afterFirst?.status).toBe("approved");
    expect(afterFirst?.approvedAt).not.toBeNull();
    expect(afterFirst?.approvedBy).toBe(ids.userA1);

    const secondApproval = await runHandler(
      approvePlaybookDefinition,
      context,
      { params: { playbookId } },
    );
    expect(getStatusCode(secondApproval)).toBeNull();
    if (!isRecord(secondApproval)) {
      throw new Error("Expected a second approve payload");
    }
    expect(secondApproval["version"]).toBe(2);
  });

  test("approving an unknown playbook 404s", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const result = await runHandler(approvePlaybookDefinition, context, {
      params: {
        playbookId: toSafeId<"playbookDefinition">(Bun.randomUUIDv7()),
      },
    });
    expect(getStatusCode(result)).toBe(404);
  });
});

describe("update after approval", () => {
  test("an update reverts an approved playbook to draft", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const playbookId = await createPlaybook(context, "Revert on edit");

    await runHandler(approvePlaybookDefinition, context, {
      params: { playbookId },
    });
    expect((await readPlaybook(playbookId))?.status).toBe("approved");

    const updateResult = await runHandler(updatePlaybookDefinition, context, {
      params: { playbookId },
      body: {
        name: "Revert on edit (edited)",
        positions: { version: 2, items: [] },
      },
    });
    expect(getStatusCode(updateResult)).toBeNull();

    const afterUpdate = await readPlaybook(playbookId);
    expect(afterUpdate?.status).toBe("draft");
    expect(afterUpdate?.name).toBe("Revert on edit (edited)");
  });
});

describe("POST /playbooks/:playbookId/versions/:version/restore", () => {
  test("restores the version's content and sets status to draft", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const playbookId = await createPlaybook(context, "Restore original");

    await runHandler(approvePlaybookDefinition, context, {
      params: { playbookId },
    }); // version 1, snapshot name = "Restore original"

    await runHandler(updatePlaybookDefinition, context, {
      params: { playbookId },
      body: {
        name: "Mutated after approval",
        positions: { version: 2, items: [] },
      },
    });
    expect((await readPlaybook(playbookId))?.name).toBe(
      "Mutated after approval",
    );
    expect((await readPlaybook(playbookId))?.status).toBe("draft");

    await runHandler(approvePlaybookDefinition, context, {
      params: { playbookId },
    }); // version 2, snapshot name = "Mutated after approval"
    expect((await readPlaybook(playbookId))?.status).toBe("approved");

    const restoreResult = await runHandler(restorePlaybookVersion, context, {
      params: { playbookId, version: 1 },
    });
    expect(getStatusCode(restoreResult)).toBeNull();
    if (!isRecord(restoreResult)) {
      throw new Error("Expected a restore payload");
    }
    expect(restoreResult["status"]).toBe("draft");

    const afterRestore = await readPlaybook(playbookId);
    expect(afterRestore?.name).toBe("Restore original");
    expect(afterRestore?.status).toBe("draft");
  });

  test("restoring an unknown version 404s", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const playbookId = await createPlaybook(context, "No versions yet");

    const result = await runHandler(restorePlaybookVersion, context, {
      params: { playbookId, version: 1 },
    });
    expect(getStatusCode(result)).toBe(404);
  });
});

describe("GET /playbooks/:playbookId/versions", () => {
  test("returns versions newest-first", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const playbookId = await createPlaybook(context, "List versions");

    await runHandler(approvePlaybookDefinition, context, {
      params: { playbookId },
    });
    await runHandler(approvePlaybookDefinition, context, {
      params: { playbookId },
    });
    await runHandler(approvePlaybookDefinition, context, {
      params: { playbookId },
    });

    const result = await runHandler(listPlaybookVersions, context, {
      params: { playbookId },
      query: {},
    });
    expect(getStatusCode(result)).toBeNull();
    if (!isRecord(result) || !Array.isArray(result["items"])) {
      throw new Error("Expected a { items } payload");
    }
    const versions = result["items"].map((item) => {
      if (!isRecord(item) || typeof item["version"] !== "number") {
        throw new Error("Expected a version row");
      }
      return item["version"];
    });
    expect(versions).toEqual([3, 2, 1]);
  });
});

describe("cross-org isolation", () => {
  test("org B cannot approve org A's playbook", async () => {
    const orgA = createOrgContext(ids.orgA, ids.userA1);
    const orgB = createOrgContext(ids.orgB, ids.userB1);
    const playbookId = await createPlaybook(orgA, "Isolation approve target");

    const result = await runHandler(approvePlaybookDefinition, orgB, {
      params: { playbookId },
    });
    expect(getStatusCode(result)).toBe(404);
    expect((await readPlaybook(playbookId))?.status).toBe("draft");
  });

  test("org B cannot list org A's playbook versions", async () => {
    const orgA = createOrgContext(ids.orgA, ids.userA1);
    const orgB = createOrgContext(ids.orgB, ids.userB1);
    const playbookId = await createPlaybook(orgA, "Isolation list target");
    await runHandler(approvePlaybookDefinition, orgA, {
      params: { playbookId },
    });

    const result = await runHandler(listPlaybookVersions, orgB, {
      params: { playbookId },
      query: {},
    });
    expect(getStatusCode(result)).toBe(404);
  });

  test("org B cannot restore a version of org A's playbook", async () => {
    const orgA = createOrgContext(ids.orgA, ids.userA1);
    const orgB = createOrgContext(ids.orgB, ids.userB1);
    const playbookId = await createPlaybook(orgA, "Isolation restore target");
    await runHandler(approvePlaybookDefinition, orgA, {
      params: { playbookId },
    });

    const result = await runHandler(restorePlaybookVersion, orgB, {
      params: { playbookId, version: 1 },
    });
    expect(getStatusCode(result)).toBe(404);
    expect((await readPlaybook(playbookId))?.status).toBe("approved");
  });
});
