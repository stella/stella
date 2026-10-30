import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { TIME_ENTRY_SOURCE } from "@stll/api-contract";
import {
  type DesktopTimeEntryBatch,
  desktopTimeEntryBatchResponseSchema,
  desktopTimeEntryBatchSchema,
  type DesktopTimeEntryClassification,
} from "@stll/api-contract/desktop-time-entries";
import { sha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
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
  type AuditEvent,
  type AuditRecorder,
  createAuditRecorder,
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
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

import { authorizeDesktopTimeEntries } from "./authorize";
import {
  type ClassifiedMatter,
  loadMatterLedes,
  matterClassificationAllowed,
} from "./matter-classification";

const canonicalClassification = (
  classification: DesktopTimeEntryClassification,
) => {
  switch (classification.type) {
    case "ledes":
      return {
        type: classification.type,
        taskCode: classification.taskCode,
        activityCode: classification.activityCode,
      };
    case "activity_group":
      return {
        type: classification.type,
        activityGroup: classification.activityGroup,
      };
    default:
      return panic(
        "Unknown time entry classification",
        classification satisfies never,
      );
  }
};

// Object construction makes fingerprints independent of JSON property order.
// An entry without a classification hashes as before the field existed, so a
// pending retry keeps its fingerprint.
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
          classification,
        }) => ({
          matterId: matterId.toLowerCase(),
          dateWorked,
          timezoneId,
          durationMinutes,
          narrative,
          billable,
          ...(classification
            ? { classification: canonicalClassification(classification) }
            : {}),
        }),
      ),
    ),
  );

/** Matter entries bill to the client, so only LEDES codes add to the entry. */
const classificationCodes = (
  classification: DesktopTimeEntryClassification | undefined,
) => {
  if (classification?.type !== "ledes") {
    return {};
  }
  return {
    taskCode: classification.taskCode,
    activityCode: classification.activityCode,
  };
};

/** Lower-cased matter ids with the accepted codes as entry fields. */
const normalizedBatchEntries = ({ entries }: DesktopTimeEntryBatch) =>
  entries.map(({ matterId, classification, ...entry }) => ({
    ...entry,
    ...classificationCodes(classification),
    matterId: matterId.toLowerCase(),
  }));

type LoadBatchMattersOptions = {
  organizationId: SafeId<"organization">;
  entries: readonly { matterId: string }[];
};

/** The batch's active matters, or null when any is missing or inactive. */
const loadBatchMatters = async (
  tx: Transaction,
  { organizationId, entries }: LoadBatchMattersOptions,
) => {
  const requestedMatterIds = [
    ...new Set(entries.map(({ matterId }) => matterId)),
  ];
  const matters = await tx.query.workspaces.findMany({
    where: {
      RAW: (table) =>
        sql`${table.id} IN (${sql.join(
          requestedMatterIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      organizationId: { eq: organizationId },
      status: { eq: "active" },
    },
    columns: { id: true, clientId: true },
    limit: requestedMatterIds.length,
  });
  return matters.length === requestedMatterIds.length ? matters : null;
};

type CheckBatchClassificationsOptions = {
  organizationId: SafeId<"organization">;
  matters: readonly ClassifiedMatter[];
  entries: DesktopTimeEntryBatch["entries"];
};

/** Read in the transaction, so codes follow the client's billing format as it
 * stands when the entries are created. */
const checkBatchClassifications = async (
  tx: Transaction,
  { organizationId, matters, entries }: CheckBatchClassificationsOptions,
) => {
  const ledesByMatter = await loadMatterLedes(tx, { organizationId, matters });
  if (
    entries.some(
      ({ matterId, classification }) =>
        classification !== undefined &&
        !matterClassificationAllowed(
          classification,
          ledesByMatter.get(matterId.toLowerCase()) ??
            panic("Authorized batch matter disappeared"),
        ),
    )
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Classification does not match the matter's billing format",
      }),
    );
  }
  return Result.ok();
};

const responseSchemas = safePublicHandlerResponseSchemasWithStatusText(
  desktopTimeEntryBatchResponseSchema,
);

export const createDesktopTimeEntryBatchEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      body: desktopTimeEntryBatchSchema,
      response: responseSchemas,
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
      const normalizedEntries = normalizedBatchEntries(body);
      const fingerprint = desktopBatchFingerprint(body);
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
          const matters = await loadBatchMatters(tx, {
            organizationId: account.organizationId,
            entries: normalizedEntries,
          });
          if (matters === null) {
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
          const classified = await checkBatchClassifications(tx, {
            organizationId: account.organizationId,
            matters,
            entries: body.entries,
          });
          if (classified.isErr()) {
            return abortTransaction(classified.error);
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
            // db-await-in-loop: ordered lock acquisition over the sorted matters; at most DESKTOP_ACTIVITY_REVIEW_LIMIT
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
          };
          for (const { workspaceId, prepared } of preparedBatch.value) {
            // db-await-in-loop: ordered single-entry inserts with buffered audit; at most DESKTOP_ACTIVITY_REVIEW_LIMIT
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
const desktopTimeEntryBatchEndpoint = createDesktopTimeEntryBatchEndpoint();

// Batch receipts serialize on the desktopBatch aggregate lock per account
// and idempotency key.
declareAggregateMutation(desktopTimeEntryBatchEndpoint, {
  type: "aggregate",
  aggregates: ["desktopBatch"],
});

export default desktopTimeEntryBatchEndpoint;
