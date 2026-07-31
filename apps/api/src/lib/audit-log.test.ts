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
    ]);

    expect(inserted).toHaveLength(2);
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
  });

  test("defaults ordinary mutations to a directly acting user", async () => {
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
      resourceId: "matter-1",
      resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
    });

    expect(inserted[0]).toMatchObject({
      activityCategory: "matter",
      performerId: "user-1",
      performerName: null,
      performerType: "user",
      triggerType: "direct",
      triggerUserId: null,
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
});
