import { describe, expect, test } from "bun:test";

import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";

import {
  legacyActivityCategory,
  parseFieldAuditResourceId,
  resolveActivityCategory,
  resolveActivityRunId,
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
