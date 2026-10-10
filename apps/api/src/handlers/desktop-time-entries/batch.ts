import { Type } from "@sinclair/typebox";
import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { TIME_ENTRY_SOURCE } from "@stll/api-contract";
import {
  desktopTimeEntryBatchSchema,
  desktopTimeEntryBatchResponseSchema,
  type DesktopTimeEntryBatchResponse,
  type DesktopTimeEntryBatch,
} from "@stll/api-contract/desktop-time-entries";
import { sha256Hex } from "@stll/sha256/bun";

import {
  abortableTx,
  abortTransaction,
  safeDbFromScoped,
} from "@/api/db/safe-db";
import { desktopTimeEntryBatches } from "@/api/db/schema";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import {
  createAuditRecorder,
  type AuditEvent,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import { readTimePolicy } from "@/api/lib/billing-time";
import {
  resolveWorkspaceRatesInTransaction,
  workspaceRateLookupKey,
} from "@/api/lib/billing/rates";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import {
  insertPreparedTimeEntry,
  lockTimeEntryCapacity,
  prepareTimeEntryInsert,
} from "@/api/lib/billing/time-entry-insert";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { jsonSchemaToTypeBox } from "@/api/lib/json-schema/json-schema-to-typebox";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

import { authorizeDesktopTimeEntries } from "./authorize";

// Object construction makes fingerprints independent of JSON property order.
export const desktopBatchFingerprint = ({ entries }: DesktopTimeEntryBatch) =>
  sha256Hex(
    JSON.stringify(
      entries.map(
        ({
          matterId,
          dateWorked,
          timezoneId,
          durationMinutes,
          narrative,
          billable,
        }) => ({
          matterId: matterId.toLowerCase(),
          dateWorked,
          timezoneId,
          durationMinutes,
          narrative,
          billable,
        }),
      ),
    ),
  );

const responseSchema = Type.Unsafe<DesktopTimeEntryBatchResponse>(
  jsonSchemaToTypeBox(toJsonSchema(desktopTimeEntryBatchResponseSchema)),
);

export const createDesktopTimeEntryBatchEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      body: desktopTimeEntryBatchSchema,
      response: safePublicHandlerResponseSchemasWithStatusText(responseSchema),
    },
    async function* ({ request, body }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      if (!hasMemberPermission(account.memberRole, { timeEntry: ["create"] })) {
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Time entry creation is not permitted",
          }),
        );
      }
      const fingerprint = desktopBatchFingerprint(body);
      const normalizedEntries = body.entries.map(({ matterId, ...entry }) => ({
        ...entry,
        matterId: matterId.toLowerCase(),
      }));
      const response = yield* Result.await(
        abortableTx(account.safeDb, async (tx) => {
          // The ledger lock and all writes share one transaction, including audits.
          await withAggregateLock({
            aggregate: "desktopBatch",
            tx,
            id: {
              organizationId: account.organizationId,
              userId: account.userId,
              idempotencyKey: body.idempotencyKey,
            },
          });
          const [receipt] = await tx
            .select()
            .from(desktopTimeEntryBatches)
            .where(
              and(
                eq(
                  desktopTimeEntryBatches.organizationId,
                  account.organizationId,
                ),
                eq(desktopTimeEntryBatches.userId, account.userId),
                eq(desktopTimeEntryBatches.idempotencyKey, body.idempotencyKey),
              ),
            )
            .limit(1);
          if (receipt?.status === "cancelled") {
            return abortTransaction(
              new HandlerError({ status: 409, message: "Batch was cancelled" }),
            );
          }
          const requestedMatterIds = [
            ...new Set(normalizedEntries.map(({ matterId }) => matterId)),
          ];
          const matters = await tx.query.workspaces.findMany({
            where: {
              RAW: (table) =>
                sql`${table.id} IN (${sql.join(
                  requestedMatterIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
              organizationId: { eq: account.organizationId },
              status: { eq: "active" },
            },
            columns: { id: true },
            limit: requestedMatterIds.length,
          });
          if (matters.length !== requestedMatterIds.length) {
            return abortTransaction(
              new HandlerError({ status: 404, message: "Matter not found" }),
            );
          }
          const workspaceIds = matters.map(({ id }) => id).toSorted();
          const authorizedIds = new Map(
            matters.map(({ id }) => [String(id), id]),
          );
          if (receipt) {
            if (receipt.requestFingerprint !== fingerprint) {
              return abortTransaction(
                new HandlerError({
                  status: 409,
                  message: "Idempotency key was used for a different batch",
                }),
              );
            }
            return (
              receipt.result ?? panic("Committed batch receipt has no result")
            );
          }
          const safeDb = safeDbFromScoped(async (run) => await run(tx));
          const rates = await resolveWorkspaceRatesInTransaction({
            tx,
            lookups: normalizedEntries.map(({ matterId, dateWorked }) => ({
              workspaceId:
                authorizedIds.get(matterId) ??
                panic("Authorized batch matter disappeared"),
              dateWorked,
              userId: account.userId,
            })),
          });
          const preparedBatch = await Result.gen(async function* () {
            const policy = yield* Result.await(
              readTimePolicy({
                safeDb,
                organizationId: account.organizationId,
              }),
            );
            const prepared = [];
            for (const { matterId, ...entry } of normalizedEntries) {
              const workspaceId =
                authorizedIds.get(matterId) ??
                panic("Authorized batch matter disappeared");
              prepared.push({
                workspaceId,
                prepared: yield* prepareTimeEntryInsert({
                  safeDb,
                  policy,
                  canApprove: canApproveTimeEntries(account.memberRole),
                  workspaceId,
                  userId: account.userId,
                  body: entry,
                  resolvedRate:
                    rates.get(
                      workspaceRateLookupKey({
                        workspaceId,
                        userId: account.userId,
                        dateWorked: entry.dateWorked,
                      }),
                    ) ?? null,
                }),
              });
            }
            return Result.ok(prepared);
          });
          if (preparedBatch.isErr()) {
            return abortTransaction(preparedBatch.error);
          }
          // Sort matter locks to preserve lock order across concurrent batches.
          for (const workspaceId of workspaceIds) {
            const capacity = await lockTimeEntryCapacity({
              tx,
              workspaceId,
              requestedEntries: normalizedEntries.filter(
                ({ matterId }) => matterId === workspaceId,
              ).length,
            });
            if (capacity.isErr()) {
              return abortTransaction(capacity.error);
            }
          }
          const entries = [];
          const auditEvents: AuditEvent[] = [];
          const bufferAuditEvent: AuditRecorder = (_tx, events) => {
            auditEvents.push(...(Array.isArray(events) ? events : [events]));
            return Promise.resolve();
          };
          for (const { workspaceId, prepared } of preparedBatch.value) {
            const entry = await insertPreparedTimeEntry({
              tx,
              organizationId: account.organizationId,
              workspaceId,
              userId: account.userId,
              source: TIME_ENTRY_SOURCE.ACTIVITY,
              prepared,
              recordAuditEvent: bufferAuditEvent,
            });
            entries.push({
              id: String(entry.id),
              matterId: String(workspaceId),
            });
          }
          const recordAuditEvent = createAuditRecorder({
            organizationId: account.organizationId,
            userId: account.userId,
            workspaceId: null,
            request,
            server: null,
          });
          await recordAuditEvent(tx, auditEvents);
          const result = { entries };
          await tx.insert(desktopTimeEntryBatches).values({
            organizationId: account.organizationId,
            userId: account.userId,
            idempotencyKey: body.idempotencyKey,
            requestFingerprint: fingerprint,
            status: "committed",
            result,
          });
          return result;
        }),
      );
      return Result.ok(response);
    },
  );
export default createDesktopTimeEntryBatchEndpoint();
