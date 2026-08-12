import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import { getEntityLinkResource } from "@/components/workspaces/tasks/task-links.logic";
import { toSafeId } from "@/lib/safe-id";

describe("task link resource identity", () => {
  test("upgrades a legacy entity ID at the client boundary", () => {
    expect(getEntityLinkResource({ id: "entity-1" })).toEqual({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">("entity-1"),
    });
  });

  test("accepts an agreeing canonical and legacy identity", () => {
    const resource = resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">("entity-1"),
    });
    expect(getEntityLinkResource({ id: "entity-1", resource })).toBe(resource);
  });

  test("rejects malformed or drifting dual identities", () => {
    expect(() =>
      getEntityLinkResource({
        id: "entity-1",
        resource: {
          type: RESOURCE_TYPE.ENTITY,
          id: "entity-2",
        },
      }),
    ).toThrow("Entity link identity disagrees with its legacy ID");
    expect(() =>
      getEntityLinkResource({ id: "entity-1", resource: { id: "entity-1" } }),
    ).toThrow("Entity link identity disagrees with its legacy ID");
  });
});
