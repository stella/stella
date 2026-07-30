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
    let insertCount = 0;
    let settingsReadWasLocked = false;
    let updateSet: unknown;
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async (lock: string) => {
                settingsReadWasLocked = lock === "update";
                return [
                  {
                    documentProcessingMode: "off" as const,
                    promptCachingEnabled: true,
                  },
                ];
              },
            }),
          }),
        }),
      }),
      insert: () => ({
        values: () => {
          insertCount += 1;
          return insertCount === 1
            ? { onConflictDoNothing: async () => {} }
            : {
                onConflictDoUpdate: async ({ set }: { set: unknown }) => {
                  updateSet = set;
                },
              };
        },
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
    expect(settingsReadWasLocked).toBe(true);
    expect(auditEvent).toMatchObject({
      changes: {
        documentProcessingMode: {
          old: "off",
          new: "searchable-text",
        },
      },
    });
  });

  test("does not acknowledge OCR opt-out while automatic work is running", async () => {
    let selectCount = 0;
    const lockedSettings = Object.assign(
      Promise.resolve([
        {
          documentProcessingMode: "searchable-text" as const,
          promptCachingEnabled: true,
        },
      ]),
      {
        for: async () => [
          {
            documentProcessingMode: "searchable-text" as const,
            promptCachingEnabled: true,
          },
        ],
      },
    );
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCount += 1;
              return selectCount === 1
                ? lockedSettings
                : Promise.resolve([{ id: "run_test" }]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {},
          onConflictDoUpdate: async () => {
            throw new Error("OCR opt-out must not be persisted");
          },
        }),
      }),
    });
    const safeDb: SafeDb = async (operation) => Result.ok(await operation(tx));
    const recordAuditEvent: AuditRecorder = async () => {};

    const result = await Result.gen(() =>
      updateOrganizationSettingsHandler({
        body: { documentProcessingMode: "off" },
        organizationId,
        recordAuditEvent,
        safeDb,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 409 });
    }
  });
});
