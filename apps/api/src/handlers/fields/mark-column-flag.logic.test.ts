import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  buildColumnFlagMutation,
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
});
