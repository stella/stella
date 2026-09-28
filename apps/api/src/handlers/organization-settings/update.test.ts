import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { updateOrganizationSettingsHandler } from "./update";

const organizationId = toSafeId<"organization">("org_test");

describe("updateOrganizationSettingsHandler", () => {
  test("rejects increments that do not divide an hour", async () => {
    const result = await Result.gen(() =>
      updateOrganizationSettingsHandler({
        body: { timeMinimumUnitMinutes: 7 },
        organizationId,
        recordAuditEvent: async () => {},
        safeDb: async () => {
          throw new Error("Invalid policy reached the database");
        },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 400 });
    }
  });

  test("rejects a lock date inside an open month", async () => {
    const result = await Result.gen(() =>
      updateOrganizationSettingsHandler({
        body: { timeLockedThroughMonth: "2026-02-27" },
        organizationId,
        recordAuditEvent: async () => {},
        safeDb: async () => {
          throw new Error("Invalid policy reached the database");
        },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 400 });
    }
  });

  test("persists policy fields and audits prior values", async () => {
    let insertCount = 0;
    let updateSet: Record<string, unknown> | undefined;
    let auditEvent: Parameters<AuditRecorder>[1] | undefined;
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [
                {
                  timeMinimumUnitMinutes: 6,
                  timeEditWindowDays: 90,
                  timeLockedThroughMonth: "2025-12-31",
                  timeNarrativeRequired: true,
                },
              ],
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
                onConflictDoUpdate: async ({
                  set,
                }: {
                  set: Record<string, unknown>;
                }) => {
                  updateSet = set;
                },
              };
        },
      }),
    });
    const result = await Result.gen(() =>
      updateOrganizationSettingsHandler({
        body: {
          timeMinimumUnitMinutes: 15,
          timeEditWindowDays: 30,
          timeLockedThroughMonth: null,
          timeNarrativeRequired: false,
        },
        organizationId,
        recordAuditEvent: async (_tx, event) => {
          auditEvent = event;
        },
        safeDb: async (operation) => Result.ok(await operation(tx)),
      }),
    );

    expect(result).toEqual(
      Result.ok({
        timeMinimumUnitMinutes: 15,
        timeEditWindowDays: 30,
        timeLockedThroughMonth: null,
        timeNarrativeRequired: false,
      }),
    );
    expect(updateSet).toMatchObject({
      timeMinimumUnitMinutes: 15,
      timeEditWindowDays: 30,
      timeLockedThroughMonth: null,
      timeNarrativeRequired: false,
    });
    const policyAuditEvent = Array.isArray(auditEvent)
      ? auditEvent.at(0)
      : auditEvent;
    expect(policyAuditEvent?.changes).toMatchObject({
      timeMinimumUnitMinutes: { old: 6, new: 15 },
      timeEditWindowDays: { old: 90, new: 30 },
      timeLockedThroughMonth: { old: "2025-12-31", new: null },
      timeNarrativeRequired: { old: true, new: false },
    });
  });

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
    let runningCondition: SQL | undefined;
    const lockedSettings = {
      for: async () => [
        {
          documentProcessingMode: "searchable-text" as const,
          promptCachingEnabled: true,
        },
      ],
    };
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: (condition: SQL) => ({
            limit: () => {
              selectCount += 1;
              if (selectCount === 2) {
                runningCondition = condition;
              }
              return selectCount === 1 ? lockedSettings : [{ id: "run_test" }];
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
    if (!runningCondition) {
      throw new Error("Expected the running OCR query condition");
    }
    const compiled = new PgDialect().sqlToQuery(runningCondition.getSQL());
    expect(compiled.params).toContain("ocr");
  });

  test("preserves OCR mode when updating an unrelated setting", async () => {
    let insertCount = 0;
    let updateSet: Record<string, unknown> | undefined;
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [
                {
                  documentProcessingMode: "searchable-text" as const,
                  promptCachingEnabled: true,
                },
              ],
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
                onConflictDoUpdate: async ({
                  set,
                }: {
                  set: Record<string, unknown>;
                }) => {
                  updateSet = set;
                },
              };
        },
      }),
    });
    const safeDb: SafeDb = async (operation) => Result.ok(await operation(tx));
    const recordAuditEvent: AuditRecorder = async () => {};

    const result = await Result.gen(() =>
      updateOrganizationSettingsHandler({
        body: { promptCachingEnabled: false },
        organizationId,
        recordAuditEvent,
        safeDb,
      }),
    );

    expect(result).toEqual(Result.ok({ promptCachingEnabled: false }));
    expect(updateSet).toMatchObject({ promptCachingEnabled: false });
    expect(updateSet).not.toHaveProperty("documentProcessingMode");
  });
});
