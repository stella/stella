import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { organizationSettings } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { readOrCreateOrganizationSettings } from "./read-or-create";

test("simultaneous first reads converge on one persisted version and one creation audit", async () => {
  const organizationId = createSafeId<"organization">();
  const updatedAt = new Date("2026-01-01T00:00:00.000Z");
  let stored: typeof organizationSettings.$inferSelect | undefined;
  const audits: AuditEvent[] = [];
  const tx = asTestRaw<Transaction>({
    query: {
      organizationSettings: {
        findFirst: async (options: unknown) => {
          expect(options).toEqual({
            where: { organizationId: { eq: organizationId } },
          });
          const row = stored;
          await Promise.resolve();
          return row;
        },
      },
    },
    insert: (table: unknown) => {
      expect(table).toBe(organizationSettings);
      return {
        values: (values: typeof organizationSettings.$inferInsert) => {
          expect(values.organizationId).toBe(organizationId);
          return {
            onConflictDoNothing: (options: unknown) => {
              expect(options).toEqual({
                target: organizationSettings.organizationId,
              });
              return {
                returning: async () => {
                  if (stored) {
                    return [];
                  }
                  stored = asTestRaw<typeof organizationSettings.$inferSelect>({
                    ...values,
                    updatedAt,
                  });
                  await Promise.resolve();
                  return [stored];
                },
              };
            },
          };
        },
      };
    },
  });
  const options = {
    tx,
    organizationId,
    recordAuditEvent: auditRecorderDouble((events) => audits.push(...events)),
  };

  const rows = await Promise.all([
    readOrCreateOrganizationSettings(options),
    readOrCreateOrganizationSettings(options),
  ]);
  const reloaded = await readOrCreateOrganizationSettings(options);

  expect(rows).toEqual([stored, stored]);
  expect(rows.map((row) => row.updatedAt.toISOString())).toEqual([
    updatedAt.toISOString(),
    updatedAt.toISOString(),
  ]);
  expect(reloaded).toBe(stored);
  expect(audits).toEqual([
    {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
    },
  ]);
});

test("fails an impossible initialization that neither creates nor finds an owner row", async () => {
  const tx = asTestRaw<Transaction>({
    query: { organizationSettings: { findFirst: async () => undefined } },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [] }),
      }),
    }),
  });
  expect(
    await rejectionOf(
      readOrCreateOrganizationSettings({
        tx,
        organizationId: createSafeId<"organization">(),
        recordAuditEvent: auditRecorderDouble(),
      }),
    ),
  ).toMatchObject({
    message: expect.stringContaining(
      "Organization settings initialization lost its row",
    ),
  });
});
