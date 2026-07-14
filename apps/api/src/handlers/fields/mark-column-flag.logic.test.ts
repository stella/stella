import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  buildColumnFlagMutation,
  buildColumnLockMutation,
  sortColumnFlagTargetsForLocking,
  type ColumnFlagTarget,
} from "./mark-column-flag.logic";

const WORKSPACE_ID = toSafeId<"workspace">("ws_mark_column_flag");
const PROPERTY_ID = toSafeId<"property">("prop_mark_column_flag");
const USER_ID = toSafeId<"user">("user_mark_column_flag");
const ADDED_AT = "2026-05-28T09:00:00.000Z";
const LOCKED_AT = "2026-05-28T08:00:00.000Z";

const createTarget = (
  entityId: string,
  entityVersionId: string,
): ColumnFlagTarget => ({
  entityId: toSafeId<"entity">(entityId),
  entityVersionId: toSafeId<"entityVersion">(entityVersionId),
});

describe("mark column flag metadata planning", () => {
  test("sorts targets before advisory lock acquisition", () => {
    const first = createTarget("ent_first", "ver_001");
    const second = createTarget("ent_second", "ver_002");
    const targets = [second, first];

    expect(sortColumnFlagTargetsForLocking(targets)).toEqual([first, second]);
    expect(targets).toEqual([second, first]);
  });

  test("adds the requested flag without overwriting existing flags or locks", () => {
    const target = createTarget("ent_needs_review", "ver_needs_review");
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: true,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: ["needs-review"],
            flagProvenance: {
              "needs-review": {
                addedBy: "user_existing",
                addedAt: "2026-05-28T07:00:00.000Z",
              },
            },
            locked: true,
            lockProvenance: {
              lockedBy: "user_lock",
              lockedAt: LOCKED_AT,
              reason: "explicit",
            },
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation.updatedCount).toBe(1);
    expect(mutation.insertValues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        entityVersionId: target.entityVersionId,
        propertyId: PROPERTY_ID,
        metadata: {
          version: 1,
          manualFlags: ["needs-review", "verified"],
          flagProvenance: {
            "needs-review": {
              addedBy: "user_existing",
              addedAt: "2026-05-28T07:00:00.000Z",
            },
            verified: {
              addedBy: USER_ID,
              addedAt: ADDED_AT,
            },
          },
          locked: true,
          lockProvenance: {
            lockedBy: "user_lock",
            lockedAt: LOCKED_AT,
            reason: "explicit",
          },
        },
        createdBy: USER_ID,
        updatedBy: USER_ID,
      },
    ]);
    expect(mutation.auditEvents).toEqual([
      {
        action: "update",
        resourceType: "field",
        resourceId: `${target.entityVersionId}:${PROPERTY_ID}`,
        changes: {
          manualFlags: {
            old: ["needs-review"],
            new: ["needs-review", "verified"],
          },
        },
        metadata: {
          entityId: target.entityId,
          entityVersionId: target.entityVersionId,
          propertyId: PROPERTY_ID,
          bulk: true,
        },
      },
    ]);
  });

  test("skips cells that already have the requested flag", () => {
    const target = createTarget("ent_verified", "ver_verified");
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: true,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: ["verified"],
            flagProvenance: {
              verified: {
                addedBy: "user_existing",
                addedAt: "2026-05-28T07:00:00.000Z",
              },
            },
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation).toEqual({
      auditEvents: [],
      insertValues: [],
      updatedCount: 0,
    });
  });

  test("skips cells that would exceed the manual flag cap", () => {
    const target = createTarget("ent_flag_cap", "ver_flag_cap");
    const existingFlags = Array.from(
      { length: 16 },
      (_, index) => `flag-${index.toString().padStart(2, "0")}`,
    );
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: true,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: existingFlags,
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation).toEqual({
      auditEvents: [],
      insertValues: [],
      updatedCount: 0,
    });
  });

  test("removes the requested flag while preserving other flags and locks", () => {
    const target = createTarget("ent_undo", "ver_undo");
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: false,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: ["needs-review", "verified"],
            flagProvenance: {
              "needs-review": {
                addedBy: "user_existing",
                addedAt: "2026-05-28T07:00:00.000Z",
              },
              verified: {
                addedBy: "user_existing",
                addedAt: "2026-05-28T07:30:00.000Z",
              },
            },
            locked: true,
            lockProvenance: {
              lockedBy: "user_lock",
              lockedAt: LOCKED_AT,
              reason: "explicit",
            },
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation.updatedCount).toBe(1);
    expect(mutation.insertValues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        entityVersionId: target.entityVersionId,
        propertyId: PROPERTY_ID,
        metadata: {
          version: 1,
          manualFlags: ["needs-review"],
          flagProvenance: {
            "needs-review": {
              addedBy: "user_existing",
              addedAt: "2026-05-28T07:00:00.000Z",
            },
          },
          locked: true,
          lockProvenance: {
            lockedBy: "user_lock",
            lockedAt: LOCKED_AT,
            reason: "explicit",
          },
        },
        createdBy: USER_ID,
        updatedBy: USER_ID,
      },
    ]);
    expect(mutation.auditEvents).toEqual([
      {
        action: "update",
        resourceType: "field",
        resourceId: `${target.entityVersionId}:${PROPERTY_ID}`,
        changes: {
          manualFlags: {
            old: ["needs-review", "verified"],
            new: ["needs-review"],
          },
        },
        metadata: {
          entityId: target.entityId,
          entityVersionId: target.entityVersionId,
          propertyId: PROPERTY_ID,
          bulk: true,
        },
      },
    ]);
  });

  test("skips removal for cells without the requested flag", () => {
    const target = createTarget("ent_no_flag", "ver_no_flag");
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: false,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: ["needs-review"],
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation).toEqual({
      auditEvents: [],
      insertValues: [],
      updatedCount: 0,
    });
  });

  test("skips removal for cells without an existing metadata row", () => {
    const target = createTarget("ent_no_row", "ver_no_row");
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: false,
      targets: [target],
      existingRows: [],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation).toEqual({
      auditEvents: [],
      insertValues: [],
      updatedCount: 0,
    });
  });

  test("onlyAddedAt undo removes the flag and the auto-lock that op added", () => {
    const target = createTarget("ent_undo_op", "ver_undo_op");
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: false,
      onlyAddedAt: ADDED_AT,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: ["verified"],
            flagProvenance: {
              verified: { addedBy: USER_ID, addedAt: ADDED_AT },
            },
            locked: true,
            lockProvenance: {
              lockedBy: USER_ID,
              lockedAt: ADDED_AT,
              reason: "explicit",
            },
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation.updatedCount).toBe(1);
    expect(mutation.insertValues.at(0)?.metadata).toEqual({
      version: 1,
      manualFlags: [],
      flagProvenance: {},
    });
  });

  test("onlyAddedAt undo skips a flag verified by an earlier operation", () => {
    const target = createTarget("ent_undo_earlier", "ver_undo_earlier");
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: false,
      onlyAddedAt: ADDED_AT,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: ["verified"],
            flagProvenance: {
              verified: { addedBy: USER_ID, addedAt: LOCKED_AT },
            },
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation).toEqual({
      auditEvents: [],
      insertValues: [],
      updatedCount: 0,
    });
  });

  test("onlyAddedAt undo removes its flag but keeps an independent lock", () => {
    const target = createTarget("ent_undo_keep_lock", "ver_undo_keep_lock");
    const mutation = buildColumnFlagMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      flag: "verified",
      set: false,
      onlyAddedAt: ADDED_AT,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: ["verified"],
            flagProvenance: {
              verified: { addedBy: USER_ID, addedAt: ADDED_AT },
            },
            locked: true,
            lockProvenance: {
              lockedBy: USER_ID,
              lockedAt: LOCKED_AT,
              reason: "explicit",
            },
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation.updatedCount).toBe(1);
    expect(mutation.insertValues.at(0)?.metadata).toEqual({
      version: 1,
      manualFlags: [],
      flagProvenance: {},
      locked: true,
      lockProvenance: {
        lockedBy: USER_ID,
        lockedAt: LOCKED_AT,
        reason: "explicit",
      },
    });
  });

  test("locks a cell while preserving flags and their provenance", () => {
    const target = createTarget("ent_lock", "ver_lock");
    const mutation = buildColumnLockMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      set: true,
      targets: [target],
      existingRows: [
        {
          entityVersionId: target.entityVersionId,
          metadata: {
            version: 1,
            manualFlags: ["needs-review"],
            flagProvenance: {
              "needs-review": {
                addedBy: "user_existing",
                addedAt: LOCKED_AT,
              },
            },
          },
        },
      ],
      userId: USER_ID,
      addedAt: ADDED_AT,
    });

    expect(mutation.updatedCount).toBe(1);
    expect(mutation.insertValues.at(0)?.metadata).toEqual({
      version: 1,
      manualFlags: ["needs-review"],
      flagProvenance: {
        "needs-review": {
          addedBy: "user_existing",
          addedAt: LOCKED_AT,
        },
      },
      locked: true,
      lockProvenance: {
        lockedBy: USER_ID,
        lockedAt: ADDED_AT,
        reason: "explicit",
      },
    });
    expect(mutation.auditEvents.at(0)?.changes).toEqual({
      locked: { old: false, new: true },
    });
  });

  test("precise undo unlocks only the lock created by that operation", () => {
    const matching = createTarget("ent_matching", "ver_matching");
    const earlier = createTarget("ent_earlier", "ver_earlier");
    const mutation = buildColumnLockMutation({
      workspaceId: WORKSPACE_ID,
      propertyId: PROPERTY_ID,
      set: false,
      onlyAddedAt: ADDED_AT,
      targets: [matching, earlier],
      existingRows: [matching, earlier].map((target) => ({
        entityVersionId: target.entityVersionId,
        metadata: {
          version: 1,
          manualFlags: [],
          flagProvenance: {},
          locked: true,
          lockProvenance: {
            lockedBy: USER_ID,
            lockedAt:
              target.entityVersionId === matching.entityVersionId
                ? ADDED_AT
                : LOCKED_AT,
            reason: "explicit",
          },
        },
      })),
      userId: USER_ID,
      addedAt: "2026-05-28T10:00:00.000Z",
    });

    expect(mutation.updatedCount).toBe(1);
    expect(mutation.insertValues.at(0)?.entityVersionId).toBe(
      matching.entityVersionId,
    );
    expect(mutation.insertValues.at(0)?.metadata).toEqual({
      version: 1,
      manualFlags: [],
      flagProvenance: {},
    });
  });
});
