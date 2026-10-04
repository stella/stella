/**
 * Which matters a position source may come from.
 *
 * Row security answers by membership: it returns a document in any matter the
 * user belongs to, including a matter being deleted, and it knows nothing of a
 * chat thread's pinned matters. The source lookup is therefore also held to
 * the matters the caller may use now. A1 is a member of three matters here:
 * `wsA1`, `wsA2`, and one that is sealed (`deleting`) partway through.
 */

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
import {
  entities,
  playbookDefinitions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import getPlaybookDefinition from "@/api/handlers/playbooks/get";
import updatePlaybookDefinition from "@/api/handlers/playbooks/update";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type {
  PlaybookPositions,
  PositionSource,
} from "@/api/lib/workflow/playbook-positions";
import { loadAccessibleMcpWorkspaces } from "@/api/mcp/context";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { filterUsableMcpWorkspaces } from "@/api/mcp/workspace-session-scope";
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

const SEALED_WORKSPACE_ID = toSafeId<"workspace">(Bun.randomUUIDv7());
const SEALED_ENTITY_ID = toSafeId<"entity">(Bun.randomUUIDv7());
const POSITION_ID = "77777777-7777-4777-8777-777777777771";
const createdPlaybookIds: SafeId<"playbookDefinition">[] = [];

const noopAuditRecorder: AuditRecorder = async () => undefined;

const membershipDbs = () => {
  const identity = {
    organizationId: ids.orgA,
    serverValidatedWorkspaceIds: [],
    userId: ids.userA1,
  };
  return {
    safeDb: asTestRaw<SafeDb>(createMembershipSafeDb(testDb, identity)),
    scopedDb: asTestRaw<ScopedDb>(createMembershipScopedDb(testDb, identity)),
  };
};

/** The matters A1 may use now, resolved the way an MCP request resolves them. */
const usableWorkspaces = async () =>
  filterUsableMcpWorkspaces({
    accessibleWorkspaces: await loadAccessibleMcpWorkspaces({
      organizationId: ids.orgA,
      scopedDb: membershipDbs().scopedDb,
    }),
    tokenWorkspaceIds: undefined,
  });

/** A1's request, narrowed to `pinned` the way a chat thread narrows it. */
const mcpContext = async (
  pinned?: readonly SafeId<"workspace">[],
): Promise<McpRequestContext> => {
  const usable = (await usableWorkspaces()).filter(
    ({ id }) => pinned === undefined || pinned.includes(id),
  );
  const workspaceIds = usable.map(({ id }) => id);
  return asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: workspaceIds,
    accessibleWorkspaceIdSet: new Set(workspaceIds),
    accessibleWorkspaceStatusById: new Map(
      usable.map(({ id, status }) => [id, status]),
    ),
    accessibleWorkspaces: usable,
    grantedScopes: [],
    memberRole: "owner",
    organizationId: ids.orgA,
    recordAuditEvent: noopAuditRecorder,
    testDependencies: {
      loadOrgSettingsForAuth: async () => ({
        orgAIConfig: null,
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        promptCachingEnabled: false,
      }),
    },
    userId: ids.userA1,
    ...membershipDbs(),
  });
};

const restContext = async () => ({
  createAuditRecorder: () => noopAuditRecorder,
  getActiveWorkspaceIds: async () =>
    (await usableWorkspaces()).map(({ id }) => id),
  getWorkspaceAccess: async () => null,
  memberRole: sessionMemberRole("owner"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  recordAuditEvent: noopAuditRecorder,
  request: new Request("https://example.test/playbooks"),
  route: "/playbooks",
  safeDb: membershipDbs().safeDb,
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
});

const positionsCiting = (sources: PositionSource[]): PlaybookPositions => ({
  version: 3,
  items: [
    {
      mode: "extract",
      sourceId: POSITION_ID,
      issue: "Governing law",
      ask: { question: "", content: { version: 1, type: "text" } },
      ...(sources.length === 0 ? {} : { sources }),
      enabled: true,
    },
  ],
});

/** A stored playbook, written past the save rule: the fixture, not the test. */
const storedPlaybook = async (
  sources: PositionSource[],
): Promise<SafeId<"playbookDefinition">> => {
  const id = toSafeId<"playbookDefinition">(Bun.randomUUIDv7());
  await testDb.insert(playbookDefinitions).values({
    id,
    organizationId: ids.orgA,
    name: "Sources",
    positions: positionsCiting(sources),
  });
  createdPlaybookIds.push(id);
  return id;
};

const storedSourceEntityIds = async (
  playbookId: SafeId<"playbookDefinition">,
) => {
  const rows = await testDb
    .select({ positions: playbookDefinitions.positions })
    .from(playbookDefinitions)
    .where(eq(playbookDefinitions.id, playbookId));
  return rows.flatMap(({ positions }) =>
    positions.items.flatMap(({ sources }) =>
      (sources ?? []).map(({ entityId }) => entityId),
    ),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const payloadOf = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): unknown => {
  const item = result.content.at(0);
  if (item?.type !== "text") {
    throw new TypeError("expected a text MCP response");
  }
  return JSON.parse(item.text);
};

/** The documents row security alone returns to A1 among `entityIds`. */
const rowSecurityReturns = async (entityIds: SafeId<"entity">[]) =>
  await membershipDbs().scopedDb(
    async (tx) =>
      await tx
        .select({ id: entities.id })
        .from(entities)
        .where(inArray(entities.id, entityIds)),
  );

const listPlaybook = async (
  context: McpRequestContext,
  playbookId: SafeId<"playbookDefinition">,
) => {
  const result = await handleMcpToolCall({
    args: { playbook_id: playbookId },
    context,
    toolName: "list_playbooks",
  });
  expect(result.isError).toBeFalsy();
  return JSON.stringify(payloadOf(result));
};

const savePlaybookCiting = async (
  context: McpRequestContext,
  entityId: SafeId<"entity">,
) => {
  const result = await handleMcpToolCall({
    args: {
      name: "Sources",
      positions: [
        {
          mode: "extract",
          issue: "Term",
          ask: { question: "How long is the term?" },
          sources: [ids.entityA2],
        },
        {
          mode: "extract",
          issue: "Notice",
          ask: { question: "How much notice?" },
          sources: [entityId],
        },
      ],
    },
    context,
    toolName: "save_playbook",
  });
  expect(result.isError).toBeFalsy();
  const payload = payloadOf(result);
  if (!isRecord(payload) || typeof payload["playbookId"] !== "string") {
    throw new TypeError("expected the playbook to be created");
  }
  const playbookId = toSafeId<"playbookDefinition">(payload["playbookId"]);
  createdPlaybookIds.push(playbookId);
  return { payload, playbookId };
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb.insert(workspaces).values({
    id: SEALED_WORKSPACE_ID,
    organizationId: ids.orgA,
    clientId: ids.contactA,
    name: "WS sealed",
    reference: `REF-SEALED-${SEALED_WORKSPACE_ID}`,
    status: "active",
  });
  await testDb.insert(workspaceMembers).values({
    id: toSafeId<"workspaceMember">(Bun.randomUUIDv7()),
    workspaceId: SEALED_WORKSPACE_ID,
    userId: ids.userA1,
  });
  await testDb.insert(entities).values({
    id: SEALED_ENTITY_ID,
    workspaceId: SEALED_WORKSPACE_ID,
    kind: "document",
    name: "sealed document",
  });
  await testDb
    .update(workspaces)
    .set({ status: "deleting" })
    .where(eq(workspaces.id, SEALED_WORKSPACE_ID));
});

afterAll(async () => {
  try {
    if (createdPlaybookIds.length > 0) {
      await testDb
        .delete(playbookDefinitions)
        .where(inArray(playbookDefinitions.id, createdPlaybookIds));
    }
    await testDb.delete(entities).where(eq(entities.id, SEALED_ENTITY_ID));
    await testDb
      .delete(workspaces)
      .where(eq(workspaces.id, SEALED_WORKSPACE_ID));
  } finally {
    await releaseRlsFixture();
  }
});

describe("playbook position sources: a matter outside the thread's pins", () => {
  test("row security alone returns the member matter's document", async () => {
    expect(await rowSecurityReturns([ids.entityA1])).toEqual([
      { id: ids.entityA1 },
    ]);
  });

  test("list_playbooks leaves out a source in a member matter the thread did not pin", async () => {
    const playbookId = await storedPlaybook([
      { workspaceId: ids.wsA1, entityId: ids.entityA1 },
      { workspaceId: ids.wsA2, entityId: ids.entityA2 },
    ]);

    const pinned = await listPlaybook(await mcpContext([ids.wsA2]), playbookId);
    expect(pinned).toContain(ids.entityA2);
    expect(pinned).not.toContain(ids.entityA1);
    expect(pinned).not.toContain(ids.wsA1);

    // The same reader with both matters in scope is shown both.
    const unpinned = await listPlaybook(await mcpContext(), playbookId);
    expect(unpinned).toContain(ids.entityA1);
  });

  test("save_playbook refuses a new source in a member matter the thread did not pin", async () => {
    const { payload, playbookId } = await savePlaybookCiting(
      await mcpContext([ids.wsA2]),
      ids.entityA1,
    );

    expect(payload).toMatchObject({
      positionCount: 1,
      issues: [{ code: "unreadable_source", path: "positions.1.sources.0" }],
    });
    expect(await storedSourceEntityIds(playbookId)).toEqual([ids.entityA2]);
  });
});

describe("playbook position sources: a sealed matter", () => {
  test("row security alone still returns the sealed matter's document", async () => {
    expect(await rowSecurityReturns([SEALED_ENTITY_ID])).toEqual([
      { id: SEALED_ENTITY_ID },
    ]);
    expect((await usableWorkspaces()).map(({ id }) => id)).not.toContain(
      SEALED_WORKSPACE_ID,
    );
  });

  test("list_playbooks leaves out a source in a sealed matter", async () => {
    const playbookId = await storedPlaybook([
      { workspaceId: SEALED_WORKSPACE_ID, entityId: SEALED_ENTITY_ID },
      { workspaceId: ids.wsA2, entityId: ids.entityA2 },
    ]);

    const listed = await listPlaybook(await mcpContext(), playbookId);
    expect(listed).toContain(ids.entityA2);
    expect(listed).not.toContain(SEALED_ENTITY_ID);
    expect(listed).not.toContain(SEALED_WORKSPACE_ID);
  });

  test("save_playbook refuses a new source in a sealed matter", async () => {
    const { payload, playbookId } = await savePlaybookCiting(
      await mcpContext(),
      SEALED_ENTITY_ID,
    );

    expect(payload).toMatchObject({
      positionCount: 1,
      issues: [{ code: "unreadable_source", path: "positions.1.sources.0" }],
    });
    expect(await storedSourceEntityIds(playbookId)).toEqual([ids.entityA2]);
  });

  test("the editor's read names no source in a sealed matter", async () => {
    const playbookId = await storedPlaybook([
      { workspaceId: SEALED_WORKSPACE_ID, entityId: SEALED_ENTITY_ID },
      { workspaceId: ids.wsA2, entityId: ids.entityA2 },
    ]);

    const result: unknown = await getPlaybookDefinition.handler(
      asTestRaw<Parameters<typeof getPlaybookDefinition.handler>[0]>({
        ...(await restContext()),
        params: { playbookId },
      }),
    );

    expect(result).toMatchObject({
      positionSources: [
        {
          workspaceId: ids.wsA2,
          entityId: ids.entityA2,
          name: "entityA2",
          workspaceName: "WS A2",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("sealed document");
    expect(JSON.stringify(result)).not.toContain("WS sealed");
  });

  test("the editor's save refuses a new source in a sealed matter", async () => {
    const playbookId = await storedPlaybook([]);

    const result: unknown = await updatePlaybookDefinition.handler(
      asTestRaw<Parameters<typeof updatePlaybookDefinition.handler>[0]>({
        ...(await restContext()),
        params: { playbookId },
        body: {
          name: "Sources",
          positions: positionsCiting([
            { workspaceId: SEALED_WORKSPACE_ID, entityId: SEALED_ENTITY_ID },
          ]),
        },
      }),
    );

    expect(result).toMatchObject({ code: 403 });
    expect(await storedSourceEntityIds(playbookId)).toEqual([]);
  });
});
