import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
  createAuditRecorder,
  recordAuditGroups,
} from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const safeId = <T extends SafeIdType>(value: string) =>
  asTestRaw<SafeId<T>>(value);

test("background audit groups batch tenant rows and preserve each group's provenance", async () => {
  const inserts: Record<string, unknown>[][] = [];
  const tx = asTestRaw<Transaction>({
    insert: () => ({
      values: async (rows: Record<string, unknown>[]) => {
        inserts.push(rows);
      },
    }),
  });
  const groups = ["org-1", "org-2"].map((organizationId) => ({
    bindings: {
      organizationId: safeId<"organization">(organizationId),
      workspaceId: null,
      userId: "user-1",
      execution: {
        performer: { type: "user" as const, id: safeId<"user">("user-1") },
        trigger: { type: "system" as const, source: "membership_removal" },
      },
    },
    events: ["task-1", "task-2"].map((resourceId) => ({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: `${organizationId}-${resourceId}`,
      workspaceId: safeId<"workspace">(`${organizationId}-matter`),
      changes: { assigneeUserId: { old: "user-1", new: null } },
      metadata: { kind: "task" },
    })),
  }));

  await recordAuditGroups({ tx, groups });

  expect(inserts).toHaveLength(1);
  const rows = inserts.flat();
  expect(rows).toHaveLength(4);
  for (const [index, group] of groups.entries()) {
    const groupRows = rows.slice(index * 2, index * 2 + 2);
    expect(new Set(groupRows.map((row) => row["groupId"])).size).toBe(1);
    for (const row of groupRows) {
      expect(row).toMatchObject({
        organizationId: group.bindings.organizationId,
        workspaceId: `${group.bindings.organizationId}-matter`,
        performerId: "user-1",
        triggerSource: "membership_removal",
        activityCategory: "tasks",
        changes: { assigneeUserId: { old: "user-1", new: null } },
      });
    }
  }
  expect(new Set(rows.map((row) => row["groupId"])).size).toBe(groups.length);
  await recordAuditGroups({ tx, groups: [] });
  expect(inserts).toHaveLength(1);
  await recordAuditGroups({
    tx,
    groups: groups.slice(0, 1),
    recordAuditEvent: createAuditRecorder({
      organizationId: safeId<"organization">("org-1"),
      workspaceId: null,
      userId: safeId<"user">("user-1"),
      request: new Request("https://example.test/", {
        headers: { "user-agent": "audit-group-test" },
      }),
      server: null,
    }),
  });
  expect(inserts).toHaveLength(2);
  expect(inserts.at(1)).toHaveLength(2);
  for (const row of inserts.at(1) ?? []) {
    expect(row).toMatchObject({
      organizationId: "org-1",
      workspaceId: "org-1-matter",
      metadata: { userAgent: "audit-group-test" },
    });
  }
});

describe("createBackgroundAuditRecorder", () => {
  test("stores bot provenance and keeps every event in one run group", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      execution: {
        performer: {
          id: "contract-review",
          name: "Contract Review",
          type: "agent",
        },
        runId: "run-1",
        trigger: {
          source: "chat",
          sourceId: "thread-1",
          type: "user_dispatch",
          userId: safeId<"user">("user-1"),
        },
      },
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    });

    await recorder(tx, [
      {
        action: AUDIT_ACTION.CREATE,
        changes: {
          created: { new: { kind: "task" }, old: null },
        },
        resourceId: "task-1",
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      },
      {
        action: AUDIT_ACTION.UPDATE,
        resourceId: "field-1",
        resourceType: AUDIT_RESOURCE_TYPE.FIELD,
      },
      {
        action: AUDIT_ACTION.UPDATE,
        resourceId: "obligation-1",
        resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
      },
    ]);

    expect(inserted).toHaveLength(3);
    expect(inserted[0]).toMatchObject({
      activityCategory: "tasks",
      groupId: inserted[1]?.["groupId"],
      performerId: "contract-review",
      performerName: "Contract Review",
      performerType: "agent",
      runId: "run-1",
      triggerSource: "chat",
      triggerSourceId: "thread-1",
      triggerType: "user_dispatch",
      triggerUserId: "user-1",
    });
    expect(inserted[1]).toMatchObject({ activityCategory: "documents" });
    expect(inserted[2]).toMatchObject({ activityCategory: "tasks" });
  });

  test("stores the transport source for a directly acting user", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      execution: {
        performer: { id: safeId<"user">("user-1"), type: "user" },
        trigger: { source: "mcp", type: "direct" },
      },
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    });

    await recorder(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceId: "matter-1",
      resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
    });

    expect(inserted[0]).toMatchObject({
      activityCategory: "matter",
      performerId: "user-1",
      performerName: null,
      performerType: "user",
      triggerType: "direct",
      triggerSource: "mcp",
      triggerUserId: null,
    });
  });

  test("infers flow run provenance from the audited resource", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      execution: {
        performer: { id: safeId<"user">("user-1"), type: "user" },
        trigger: { type: "direct" },
      },
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    });

    await recorder(tx, {
      action: AUDIT_ACTION.EXECUTE,
      resourceId: "flow-run-1",
      resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
    });

    expect(inserted[0]).toMatchObject({ runId: "flow-run-1" });
  });

  test("keeps explicit run provenance and categorizes playbook execution", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      execution: {
        performer: { id: "router", name: "Router", type: "service" },
        runId: "service-run-1",
        trigger: { type: "system" },
      },
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    });

    await recorder(tx, {
      action: AUDIT_ACTION.EXECUTE,
      resourceId: "playbook-1",
      resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
    });

    expect(inserted[0]).toMatchObject({
      activityCategory: "automation",
      runId: "service-run-1",
    });
  });

  test("categorizes correspondence as matter correspondence activity", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      execution: {
        performer: { id: safeId<"user">("user-1"), type: "user" },
        trigger: { type: "direct" },
      },
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    });

    await recorder(tx, {
      action: AUDIT_ACTION.CREATE,
      metadata: { subject: "Court filing" },
      resourceId: "correspondence-1",
      resourceType: AUDIT_RESOURCE_TYPE.CORRESPONDENCE,
    });

    expect(inserted[0]).toMatchObject({
      activityCategory: "correspondence",
      resourceType: "correspondence",
    });
  });

  test("categorizes deleted task entities from the persisted diff", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      execution: {
        performer: { id: safeId<"user">("user-1"), type: "user" },
        trigger: { type: "direct" },
      },
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    });

    await recorder(tx, {
      action: AUDIT_ACTION.DELETE,
      changes: {
        deleted: {
          new: null,
          old: { id: "task-1", kind: "task" },
        },
      },
      resourceId: "task-1",
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
    });

    expect(inserted[0]).toMatchObject({ activityCategory: "tasks" });
  });

  test("categorizes task field edits from the owning entity kind", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      execution: {
        performer: { id: safeId<"user">("user-1"), type: "user" },
        trigger: { type: "direct" },
      },
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    });

    await recorder(tx, {
      action: AUDIT_ACTION.UPDATE,
      metadata: { entityId: "task-1", kind: "task" },
      resourceId: "version-1:property-1",
      resourceType: AUDIT_RESOURCE_TYPE.FIELD,
    });

    expect(inserted[0]).toMatchObject({ activityCategory: "tasks" });
  });

  test("categorizes task version edits from the owning entity kind", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      execution: {
        performer: { id: safeId<"user">("user-1"), type: "user" },
        trigger: { type: "direct" },
      },
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    });

    await recorder(tx, {
      action: AUDIT_ACTION.UPDATE,
      metadata: { entityId: "task-1", kind: "task" },
      resourceId: "version-1",
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
    });

    expect(inserted[0]).toMatchObject({ activityCategory: "tasks" });
  });
});

describe("audit detail projection", () => {
  test("request and background recorders use the same thread detail policy", async () => {
    const bindings = {
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: safeId<"workspace">("workspace-1"),
    };
    const recorders = [
      createBackgroundAuditRecorder({
        ...bindings,
        execution: {
          performer: { type: "user", id: bindings.userId },
          trigger: { type: "direct" },
        },
      }),
      createAuditRecorder({
        ...bindings,
        request: new Request("https://example.test"),
        server: null,
      }),
    ];
    for (const recorder of recorders) {
      let inserted: Record<string, unknown>[] = [];
      const tx = asTestRaw<Transaction>({
        insert: () => ({
          values: async (rows: Record<string, unknown>[]) => {
            inserted = rows;
          },
        }),
      });
      // A payload from before the field list existed, shaped as stored.
      await recorder(
        tx,
        asTestRaw<AuditEvent>({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: "thread-1",
          changes: {
            title: { old: "Chat A", new: "Chat B" },
            name: { old: "Chat A", new: "Chat B" },
            chatModel: { old: "model-a", new: "model-b" },
            created: {
              old: null,
              new: { title: "Chat A", summary: "Chat A", chatModel: "model-a" },
            },
          },
          metadata: { title: "Chat A", threadId: "thread-1" },
        }),
      );
      expect(inserted.at(0)?.["changes"]).toEqual({
        chatModel: { old: "model-a", new: "model-b" },
        created: { old: null, new: { chatModel: "model-a" } },
      });
      expect(inserted.at(0)?.["metadata"]).toMatchObject({
        threadId: "thread-1",
      });
      expect(inserted.at(0)?.["metadata"]).not.toHaveProperty("title");
    }
  });

  test("chat message and file entries keep no change fields", async () => {
    let inserted: Record<string, unknown>[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });
    const recorder = createBackgroundAuditRecorder({
      organizationId: safeId<"organization">("org-1"),
      userId: safeId<"user">("user-1"),
      workspaceId: null,
      execution: {
        performer: { type: "user", id: safeId<"user">("user-1") },
        trigger: { type: "direct" },
      },
    });
    await recorder(
      tx,
      [AUDIT_RESOURCE_TYPE.CHAT_MESSAGE, AUDIT_RESOURCE_TYPE.CHAT_FILE].map(
        (resourceType) =>
          asTestRaw<AuditEvent>({
            action: AUDIT_ACTION.UPDATE,
            resourceType,
            resourceId: "resource-1",
            changes: { text: { old: "Chat A", new: "Chat B" } },
          }),
      ),
    );
    expect(inserted.map((row) => row["changes"])).toEqual([{}, {}]);
  });

  test("chat entries accept only their listed change fields", () => {
    const listed: AuditEvent = {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
      resourceId: "thread-1",
      changes: {
        dataWorkspaceIds: { old: [], new: ["workspace-1"] },
        titleChanged: { old: false, new: true },
      },
    };
    const unlisted: AuditEvent = {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
      resourceId: "thread-1",
      changes: {
        // @ts-expect-error -- free text is not a chat thread change field
        title: { old: "Chat A", new: "Chat B" },
      },
    };
    expect([listed, unlisted]).toHaveLength(2);
  });
});
