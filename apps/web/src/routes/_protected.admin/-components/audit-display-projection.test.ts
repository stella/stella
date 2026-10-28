import { expect, test } from "bun:test";

import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@stll/api-contract/audit-log";

import {
  AUDIT_ACTION_PROJECTIONS,
  AUDIT_RESOURCE_PROJECTIONS,
  projectAuditResourceLabel,
} from "./audit-display-projection";

test("every audit action and resource kind has a display projection", () => {
  expect(Object.keys(AUDIT_ACTION_PROJECTIONS).toSorted()).toEqual(
    Object.values(AUDIT_ACTION).toSorted(),
  );
  expect(Object.keys(AUDIT_RESOURCE_PROJECTIONS).toSorted()).toEqual(
    Object.values(AUDIT_RESOURCE_TYPE).toSorted(),
  );
});

test("status-only matter rows retain their distinct current names", () => {
  const labels = ["Northwind acquisition", "Contoso dispute"].map((name) =>
    projectAuditResourceLabel({
      action: AUDIT_ACTION.UPDATE,
      resource: { kind: AUDIT_RESOURCE_TYPE.WORKSPACE, name },
      deletedLabel: (kind) => `deleted ${kind}`,
      kind: "matter",
      unavailableLabel: (kind) => `${kind} (not available)`,
    }),
  );
  expect(labels).toEqual(["Northwind acquisition", "Contoso dispute"]);
});

test("a Czech matter update uses the translated resource kind", () => {
  const label = projectAuditResourceLabel({
    action: AUDIT_ACTION.UPDATE,
    resource: { kind: AUDIT_RESOURCE_TYPE.WORKSPACE, name: null },
    deletedLabel: (kind) => `smazaná položka: ${kind}`,
    kind: "spis",
    unavailableLabel: (kind) => `${kind} (není k dispozici)`,
  });
  expect(label).toBe("spis (není k dispozici)");
});
