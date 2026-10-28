import { expect, test } from "bun:test";

import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@stll/api-contract/audit-log";

import cs from "@/i18n/langs/cs.json";
import de from "@/i18n/langs/de.json";

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

test("Czech and German catalogues render translated resource kinds", () => {
  const cases = [
    [cs, "dokument nebo úkol (není k dispozici)"],
    [de, "Dokument oder Aufgabe (nicht verfügbar)"],
  ] as const;
  for (const [catalogue, expected] of cases) {
    const messages = catalogue.settings.organization;
    const label = projectAuditResourceLabel({
      action: AUDIT_ACTION.UPDATE,
      resource: { kind: AUDIT_RESOURCE_TYPE.ENTITY, name: null },
      deletedLabel: (value) =>
        messages.auditLogsDeletedResource.replace("{kind}", () => value),
      kind: messages.auditResourceKinds.entity,
      unavailableLabel: (value) =>
        messages.auditLogsUnavailableResource.replace("{kind}", () => value),
    });
    expect(label).toBe(expected);
  }
});

test("status-only contact and invoice rows retain their names", () => {
  for (const [kind, name] of [
    [AUDIT_RESOURCE_TYPE.CONTACT, "Ada Lovelace"],
    [AUDIT_RESOURCE_TYPE.INVOICE, "2026-0042"],
  ] as const) {
    expect(
      projectAuditResourceLabel({
        action: AUDIT_ACTION.UPDATE,
        resource: { kind, name },
        deletedLabel: (value) => `deleted ${value}`,
        kind,
        unavailableLabel: (value) => `${value} unavailable`,
      }),
    ).toBe(name);
  }
});
