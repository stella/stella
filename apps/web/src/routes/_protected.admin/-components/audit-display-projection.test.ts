import { expect, test } from "bun:test";

import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@stll/api-contract/audit-log";

import {
  AUDIT_ACTION_PROJECTIONS,
  AUDIT_RESOURCE_PROJECTIONS,
  projectAuditResourceLabel,
  resourceNameFromChanges,
} from "./audit-display-projection";

test("every audit action and resource kind has a display projection", () => {
  expect(Object.keys(AUDIT_ACTION_PROJECTIONS).toSorted()).toEqual(
    Object.values(AUDIT_ACTION).toSorted(),
  );
  expect(Object.keys(AUDIT_RESOURCE_PROJECTIONS).toSorted()).toEqual(
    Object.values(AUDIT_RESOURCE_TYPE).toSorted(),
  );
});

test("deleted and unknown resources show a kind and never an identifier", () => {
  const uuid = "019a0000-0000-7000-8000-000000000002";
  const label = projectAuditResourceLabel({
    action: AUDIT_ACTION.DELETE,
    changes: { id: uuid },
    resourceType: "future_resource_kind",
    deletedLabel: (kind) => `deleted ${kind}`,
    unknownLabel: "item",
  });
  expect(label).toBe("deleted item");
  expect(label).not.toContain(uuid);
});

test("resource names come from display fields rather than identifiers", () => {
  const uuid = "019a0000-0000-7000-8000-000000000002";
  expect(
    resourceNameFromChanges({
      name: { old: null, new: "Court filing" },
      id: uuid,
    }),
  ).toBe("Court filing");
  expect(resourceNameFromChanges({ id: uuid })).toBeNull();
});
