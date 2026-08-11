import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const safeId = <T extends SafeIdType>(value: string) =>
  asTestRaw<SafeId<T>>(value);

describe("createBackgroundAuditRecorder", () => {
  test("batches large groups without splitting their audit identity", async () => {
    const insertedBatches: Record<string, unknown>[][] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          insertedBatches.push(rows);
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
    const events = Array.from({ length: 501 }, (_, index) => ({
      action: AUDIT_ACTION.DELETE,
      resourceId: `entity-${index}`,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
    }));

    await recorder(tx, events);

    expect(insertedBatches.map((batch) => batch.length)).toEqual([500, 1]);
    const groupIds = new Set(
      insertedBatches.flatMap((batch) =>
        batch.map((row) => row["groupId"]),
      ),
    );
    expect(groupIds.size).toBe(1);
  });

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
