import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { updateOrganizationSettingsHandler } from "./update";

const organizationId = toSafeId<"organization">("org_test");

describe("updateOrganizationSettingsHandler", () => {
  test("persists an OCR policy mode and records the transition", async () => {
    let auditEvent: Parameters<AuditRecorder>[1] | undefined;
    let updateSet: unknown;
    const tx = asTestRaw<Transaction>({
      query: {
        organizationSettings: {
          findFirst: async () => ({
            documentProcessingMode: "off" as const,
            promptCachingEnabled: true,
          }),
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async ({ set }: { set: unknown }) => {
            updateSet = set;
          },
        }),
      }),
    });
    const safeDb: SafeDb = async (operation) => Result.ok(await operation(tx));
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      auditEvent = event;
    };

    const result = await Result.gen(() =>
      updateOrganizationSettingsHandler({
        body: { documentProcessingMode: "searchable-text" },
        organizationId,
        recordAuditEvent,
        safeDb,
      }),
    );

    expect(result).toEqual(
      Result.ok({ documentProcessingMode: "searchable-text" }),
    );
    expect(updateSet).toEqual(
      expect.objectContaining({ documentProcessingMode: "searchable-text" }),
    );
    expect(auditEvent).toMatchObject({
      changes: {
        documentProcessingMode: {
          old: "off",
          new: "searchable-text",
        },
      },
    });
  });
});
