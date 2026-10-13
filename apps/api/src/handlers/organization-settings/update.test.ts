import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { MANAGED_AI_RESIDENCIES } from "@/api/lib/chat/ai-data-policy";
import { ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH } from "@/api/lib/chat/organization-ai-instructions";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { settingsSelectFixture } from "./settings-select.fixture";
import updateOrganizationSettings, {
  updateOrganizationSettingsHandler,
} from "./update";

const organizationId = toSafeId<"organization">("org_test");

describe("updateOrganizationSettingsHandler", () => {
  test("bounds organization instructions while allowing clearing and Unicode", () => {
    for (const aiInstructions of [
      "",
      "أجب بالعربية",
      "§".repeat(ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH),
      "𐐀".repeat(ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH / 2),
    ]) {
      expect(
        Value.Check(updateOrganizationSettings.config.body, { aiInstructions }),
      ).toBe(true);
    }
    expect(
      Value.Check(updateOrganizationSettings.config.body, {
        aiInstructions: "a".repeat(ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH + 1),
      }),
    ).toBe(false);
    expect(
      Value.Check(updateOrganizationSettings.config.body, {
        aiInstructions: null,
      }),
    ).toBe(false);
  });

  test("saving or clearing instructions preserves either caching preference and audits without prompt content", async () => {
    for (const promptCachingEnabled of [true, false]) {
      for (const aiInstructions of ["Use Czech legal terminology.", ""]) {
        const prior = "Prefer English.";
        let updateSet: Record<string, unknown> | undefined;
        let auditEvent: Parameters<AuditRecorder>[1] | undefined;
        const tx = asTestRaw<Transaction>({
          select: settingsSelectFixture(() =>
            [{ aiInstructions: prior, promptCachingEnabled }].map((row) => ({
              organizationId,
              ...row,
            })),
          ),
          insert: () => ({
            values: () => ({
              onConflictDoNothing: async () => {},
              onConflictDoUpdate: async ({
                set,
              }: {
                set: Record<string, unknown>;
              }) => {
                updateSet = set;
              },
            }),
          }),
        });
        const safeDb: SafeDb = async (operation) =>
          Result.ok(await operation(tx));
        const result = await Result.gen(() =>
          updateOrganizationSettingsHandler({
            body: { aiInstructions },
            organizationId,
            safeDb,
            recordAuditEvent: async (auditTx, event) => {
              expect(auditTx).toBe(tx);
              auditEvent = event;
            },
          }),
        );
        expect(result).toEqual(Result.ok({ aiInstructions }));
        expect(updateSet).toMatchObject({ aiInstructions });
        expect(updateSet).not.toHaveProperty("promptCachingEnabled");
        expect(updateSet).not.toHaveProperty("managedAIResidency");
        expect(auditEvent).toMatchObject({
          resourceId: organizationId,
          changes: {
            aiInstructions: {
              old: { characterCount: Array.from(prior).length },
              new: { characterCount: Array.from(aiInstructions).length },
            },
          },
        });
        expect(JSON.stringify(auditEvent)).not.toContain(prior);
        if (aiInstructions !== "") {
          expect(JSON.stringify(auditEvent)).not.toContain(aiInstructions);
        }
      }
    }
  });

  test("accepts the supported residency settings for organization administrators", () => {
    for (const managedAIResidency of MANAGED_AI_RESIDENCIES) {
      expect(
        Value.Check(updateOrganizationSettings.config.body, {
          managedAIResidency,
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(updateOrganizationSettings.config.body, {
        managedAIResidency: "other",
      }),
    ).toBe(false);
    for (const role of ["owner", "admin"] as const) {
      expect(
        hasMemberPermission(
          sessionMemberRole(role),
          updateOrganizationSettings.config.permissions,
        ),
      ).toBe(true);
    }
    for (const role of ["member", "intern", "external"] as const) {
      expect(
        hasMemberPermission(
          sessionMemberRole(role),
          updateOrganizationSettings.config.permissions,
        ),
      ).toBe(false);
    }
  });

  test("persists the residency setting with the prior value in its audit event", async () => {
    let insertCount = 0;
    let updateSet: Record<string, unknown> | undefined;
    let auditEvent: Parameters<AuditRecorder>[1] | undefined;
    const tx = asTestRaw<Transaction>({
      select: settingsSelectFixture(() =>
        [{ managedAIResidency: "eu" }].map((row) => ({
          organizationId,
          ...row,
        })),
      ),
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
    const recordAuditEvent: AuditRecorder = async (auditTx, event) => {
      expect(auditTx).toBe(tx);
      auditEvent = event;
    };
    const result = await Result.gen(() =>
      updateOrganizationSettingsHandler({
        body: { managedAIResidency: "us" },
        organizationId,
        recordAuditEvent,
        safeDb,
      }),
    );
    expect(result).toEqual(Result.ok({ managedAIResidency: "us" }));
    expect(updateSet).toMatchObject({ managedAIResidency: "us" });
    expect(updateSet).not.toHaveProperty("promptCachingEnabled");
    expect(auditEvent).toMatchObject({
      resourceId: organizationId,
      changes: { managedAIResidency: { old: "eu", new: "us" } },
    });
  });

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
      select: settingsSelectFixture(() =>
        [
          {
            timeMinimumUnitMinutes: 6,
            timeEditWindowDays: 90,
            timeLockedThroughMonth: "2025-12-31",
            timeNarrativeRequired: true,
          },
        ].map((row) => ({ organizationId, ...row })),
      ),
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
      select: settingsSelectFixture((statement) => {
        settingsReadWasLocked = new PgDialect()
          .sqlToQuery(statement)
          .sql.toUpperCase()
          .includes("FOR UPDATE");
        return [
          {
            organizationId,
            documentProcessingMode: "off",
            promptCachingEnabled: true,
          },
        ];
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
    const tx = asTestRaw<Transaction>({
      select: settingsSelectFixture((statement) => {
        selectCount += 1;
        if (selectCount === 2) {
          runningCondition = statement;
          return [{ id: "run_test" }];
        }
        return [
          {
            organizationId,
            documentProcessingMode: "searchable-text",
            promptCachingEnabled: true,
          },
        ];
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
      select: settingsSelectFixture(() =>
        [
          {
            documentProcessingMode: "searchable-text" as const,
            promptCachingEnabled: true,
          },
        ].map((row) => ({ organizationId, ...row })),
      ),
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
