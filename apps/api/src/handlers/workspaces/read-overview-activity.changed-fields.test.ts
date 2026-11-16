import { describe, expect, test } from "bun:test";

import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

import { activityChangedFields } from "./read-overview-activity.query";

describe("matter activity changed fields", () => {
  test("returns every changed task field without its values", () => {
    expect(
      activityChangedFields({
        changes: {
          priority: { old: "normal", new: "high" },
          status: { old: "todo", new: "done" },
        },
        entityKind: "task",
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      }),
    ).toEqual(["priority", "status"]);
  });

  test("returns only name for a name-only change", () => {
    expect(
      activityChangedFields({
        changes: { name: { old: "Old name", new: "New name" } },
        entityKind: "folder",
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      }),
    ).toEqual(["name"]);
  });
});
