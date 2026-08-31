import { describe, expect, test } from "bun:test";

import type { MatterActivityFilters } from "@stll/api-contract/matter-activity";

import { auditLogs } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { brandPersistedAuditLogId } from "@/api/lib/safe-id-boundaries";

import {
  ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE,
  activityTargetSource,
  bindActivityCursorToFilters,
  FEED_ACTIVITY_RESOURCE_TYPES,
  legacyActivityCategory,
  parseFieldAuditResourceId,
  resolveActivityAction,
  resolveActivityCategory,
  resolveActivityRunId,
  timestampMicroseconds,
  VISIBLE_ACTIVITY_ACTION_BY_ACTION,
  VISIBLE_ACTIVITY_ACTIONS,
} from "./read-overview-activity.logic";

const fieldId = toSafeId<"field">("00000000-0000-0000-0000-000000000001");
const entityVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000002",
);
const propertyId = "00000000-0000-0000-0000-000000000003";

describe("parseFieldAuditResourceId", () => {
  test("keeps persisted field ids on the field lookup path", () => {
    expect(parseFieldAuditResourceId(fieldId)).toEqual({
      fieldId,
      type: "field",
    });
  });

  test("extracts the entity version from composite cell audit ids", () => {
    expect(
      parseFieldAuditResourceId(`${entityVersionId}:${propertyId}`),
    ).toEqual({ entityVersionId, type: "cell" });
  });

  test("rejects malformed persisted values before UUID queries", () => {
    expect(
      parseFieldAuditResourceId(`${entityVersionId}:not-a-uuid`),
    ).toBeNull();
    expect(parseFieldAuditResourceId("not-a-field-id")).toBeNull();
  });
});

describe("legacyActivityCategory", () => {
  test("keeps task deletions and member additions in their original categories", () => {
    expect(
      legacyActivityCategory(AUDIT_RESOURCE_TYPE.ENTITY, "task", false),
    ).toBe("tasks");
    expect(
      legacyActivityCategory(AUDIT_RESOURCE_TYPE.WORKSPACE, null, true),
    ).toBe("team");
    expect(
      legacyActivityCategory(AUDIT_RESOURCE_TYPE.WORKSPACE, null, false),
    ).toBe("matter");
  });

  test("keeps legacy task version and field events in Tasks", () => {
    expect(
      legacyActivityCategory(AUDIT_RESOURCE_TYPE.ENTITY_VERSION, "task", false),
    ).toBe("tasks");
    expect(
      legacyActivityCategory(AUDIT_RESOURCE_TYPE.FIELD, "task", false),
    ).toBe("tasks");
  });

  test("overrides stale document categories for task resources", () => {
    expect(
      resolveActivityCategory({
        kind: "task",
        persistedCategory: "documents",
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
        workspaceTeamEvent: false,
      }),
    ).toBe("tasks");
  });

  test("derives automation for legacy playbook activity", () => {
    expect(
      resolveActivityCategory({
        kind: null,
        persistedCategory: "other",
        resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
        workspaceTeamEvent: false,
      }),
    ).toBe("automation");
  });
});

describe("resolveActivityRunId", () => {
  test("recovers legacy flow run ids from the resource", () => {
    expect(
      resolveActivityRunId({
        resourceId: "flow-run-1",
        resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
        runId: null,
      }),
    ).toBe("flow-run-1");
  });

  test("preserves explicit run ids and ignores unrelated resources", () => {
    expect(
      resolveActivityRunId({
        resourceId: "flow-run-1",
        resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
        runId: "dispatch-run-1",
      }),
    ).toBe("dispatch-run-1");
    expect(
      resolveActivityRunId({
        resourceId: "entity-1",
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        runId: null,
      }),
    ).toBeNull();
  });
});

describe("resolveActivityAction", () => {
  test("uses relationship semantics without rewriting entity mutations", () => {
    expect(
      resolveActivityAction({ action: "update", relationshipChange: "add" }),
    ).toBe("add");
    expect(
      resolveActivityAction({
        action: "delete",
        relationshipChange: "remove",
      }),
    ).toBe("remove");
    expect(
      resolveActivityAction({ action: "delete", relationshipChange: null }),
    ).toBe("delete");
  });
});

const defaultFilters = {
  action: "all",
  actorId: null,
  category: "all",
  from: null,
  toExclusive: null,
} as const satisfies MatterActivityFilters;

describe("activity filter cursors", () => {
  const codec = createTimestampIdCursorCodec({
    column: auditLogs.createdAt,
    brandId: brandPersistedAuditLogId,
  });
  const auditLogId = "00000000-0000-0000-0000-000000000004";
  const timestamp = "2026-08-13T09:10:11.123456Z";

  test("round-trips only under the exact filter identity", () => {
    const cursor = bindActivityCursorToFilters({
      codec,
      filters: defaultFilters,
    }).encode(timestamp, auditLogId);
    expect(
      bindActivityCursorToFilters({
        codec,
        filters: defaultFilters,
      }).decode(cursor),
    ).not.toBeNull();

    const changedFilters: MatterActivityFilters[] = [
      { ...defaultFilters, action: "update" },
      { ...defaultFilters, actorId: "user-1" },
      { ...defaultFilters, category: "documents" },
      { ...defaultFilters, from: "2026-08-01T00:00:00.000Z" },
      { ...defaultFilters, toExclusive: "2026-09-01T00:00:00.000Z" },
    ];
    for (const filters of changedFilters) {
      expect(
        bindActivityCursorToFilters({ codec, filters }).decode(cursor),
      ).toBeNull();
    }
  });

  test("keeps the emitted cursor within the accepted bound at maximum filter sizes", () => {
    const cursor = bindActivityCursorToFilters({
      codec,
      filters: {
        action: "execute",
        actorId: "actor".repeat(25).concat("abc"),
        category: "automation",
        from: "2026-08-13T09:10:11.123456+14:00",
        toExclusive: "2026-08-14T09:10:11.123456-14:00",
      },
    }).encode(timestamp, auditLogId);

    expect(cursor.length).toBeLessThanOrEqual(512);
  });
});

describe("activity target sources", () => {
  test("names or excludes every audited resource type, for every action", () => {
    const resourceTypes = Object.values(AUDIT_RESOURCE_TYPE);
    const actions = Object.values(AUDIT_ACTION);
    expect(resourceTypes.length).toBeGreaterThan(0);

    for (const resourceType of resourceTypes) {
      const source = ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE[resourceType];
      const feeds = FEED_ACTIVITY_RESOURCE_TYPES.includes(resourceType);
      expect(feeds).toBe(source !== null);
      for (const action of actions) {
        const visible = VISIBLE_ACTIVITY_ACTION_BY_ACTION[action];
        if (source === null || visible === null) {
          continue;
        }
        // Whatever the pair, the row resolves to a target the feed can name
        // rather than falling through to an unnamed automation label.
        expect(activityTargetSource(resourceType)).toBe(source);
      }
    }
  });

  test("keeps the automation target for automation runs only", () => {
    const automationTargets = FEED_ACTIVITY_RESOURCE_TYPES.filter(
      (resourceType) =>
        ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE[resourceType] === "automation",
    );

    expect(automationTargets).toEqual([AUDIT_RESOURCE_TYPE.FLOW_RUN]);
    expect(
      ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE[
        AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN
      ],
    ).toBe("documentReviewRun");
    // Obligations are audited against the task entity they govern, so they
    // read as that task rather than as an unnamed record.
    expect(
      ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE[
        AUDIT_RESOURCE_TYPE.WORK_OBLIGATION
      ],
    ).toBe("entity");
  });

  test("panics on a resource type the allow-list should have filtered", () => {
    expect(() =>
      activityTargetSource(AUDIT_RESOURCE_TYPE.CHAT_MESSAGE),
    ).toThrow("Activity row has no target source: chat_message");
    expect(() => activityTargetSource("not_a_resource_type")).toThrow(
      "Activity row has no target source: not_a_resource_type",
    );
  });

  test("narrates state changes and never access records", () => {
    expect(VISIBLE_ACTIVITY_ACTIONS).not.toContain(AUDIT_ACTION.ACCESS);
    expect(VISIBLE_ACTIVITY_ACTIONS).not.toContain(AUDIT_ACTION.DOWNLOAD);
    expect(VISIBLE_ACTIVITY_ACTIONS).toContain(AUDIT_ACTION.REVIEW);
    expect(VISIBLE_ACTIVITY_ACTIONS).toContain(AUDIT_ACTION.EXECUTE);
  });
});

describe("activity date bounds", () => {
  test("retains fractional precision with lowercase RFC 3339 timezone markers", () => {
    const lower = timestampMicroseconds("2026-08-13T09:10:11.800000z");
    const upper = timestampMicroseconds("2026-08-13T09:10:11.900000z");

    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect((upper ?? 0n) - (lower ?? 0n)).toBe(100_000n);
  });
});
