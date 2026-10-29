import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import { auditLogs, USAGE_ACTION_TYPES, usageEvents } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { transcriptionUsageUnits } from "@/api/lib/usage/unit-model";
import { recordUsageEvent } from "@/api/lib/usage/usage-ledger";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("transcription settlement (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(true).toBe(true);
    });
  });
} else {
  test("transcription records duration usage and bounded audit metadata once", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const outcome = await Result.tryPromise(() =>
        db.transaction(async (tx) => {
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const requestId = Bun.randomUUIDv7();
          const period = {
            start: new Date("2026-10-01T00:00:00Z"),
            end: new Date("2026-11-01T00:00:00Z"),
          };
          await tx.insert(organization).values({
            id: organizationId,
            name: "Spis Lípa",
            slug: `spis-${organizationId}`,
            createdAt: period.start,
          });
          await tx.insert(user).values({
            id: userId,
            name: "Žofie Šimůnková",
            email: `${userId}@fixture.test`,
          });
          const modelId = "mistralai/voxtral-mini-transcribe";
          const durationMs = 1_000_000;
          const measured = transcriptionUsageUnits({
            modelId,
            residency: "eu",
            durationMs,
            isByok: false,
          });
          const input = {
            tx,
            organizationId,
            workspaceId: null,
            userId,
            actionType: "transcription",
            modelTask: "transcription",
            serviceTier: "standard",
            isByok: false,
            period,
            idempotencyKey: requestId,
            ...measured,
          } as const;
          const first = await recordUsageEvent(input);
          expect(first).toEqual({ status: "recorded" });
          expect(await recordUsageEvent(input)).toEqual({
            status: "duplicate",
          });
          const recordAuditEvent = createBackgroundAuditRecorder({
            organizationId,
            workspaceId: null,
            userId,
            execution: {
              performer: { type: "user", id: userId },
              trigger: { type: "direct" },
            },
          });
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.EXECUTE,
            resourceType: AUDIT_RESOURCE_TYPE.USAGE_EVENT,
            resourceId: requestId,
            metadata: {
              operation: "dictation.transcribe",
              modelId,
              durationMs,
            },
          });
          const rows = await tx
            .select({
              actionType: usageEvents.actionType,
              modelRole: usageEvents.modelRole,
              unitsConsumed: usageEvents.unitsConsumed,
              rawUsageMicroUnits: usageEvents.rawUsageMicroUnits,
              workspaceId: usageEvents.workspaceId,
            })
            .from(usageEvents)
            .where(eq(usageEvents.organizationId, organizationId));
          expect(rows).toEqual([
            {
              actionType: "transcription",
              modelRole: "transcription",
              unitsConsumed: 83,
              rawUsageMicroUnits: 5500,
              workspaceId: null,
            },
          ]);
          const audit = await tx
            .select({
              metadata: auditLogs.metadata,
              resourceId: auditLogs.resourceId,
            })
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId));
          expect(audit).toEqual([
            {
              resourceId: requestId,
              metadata: {
                operation: "dictation.transcribe",
                modelId,
                durationMs,
              },
            },
          ]);
          for (const actionType of USAGE_ACTION_TYPES) {
            await recordUsageEvent({
              ...input,
              actionType,
              isByok: true,
              unitsConsumed: 0,
              idempotencyKey: `domain-${actionType}`,
            });
          }
          const invalid = await Result.tryPromise(() =>
            tx.transaction(async (inner) => {
              await inner.execute(
                sql`UPDATE usage_events SET action_type = 'unsupported' WHERE organization_id = ${organizationId}`,
              );
            }),
          );
          expect(invalid.isErr()).toBe(true);
          if (invalid.isErr()) {
            expect(
              isPgConstraintError(
                invalid.error,
                PG_ERROR.CHECK_VIOLATION,
                "usage_events_action_type_domain",
              ),
            ).toBe(true);
          }
          tx.rollback();
        }),
      );
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error.cause).toBeInstanceOf(TransactionRollbackError);
      }
    });
  });
}
