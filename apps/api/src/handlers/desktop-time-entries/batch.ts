import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import {
  TIME_ENTRY_ACTIVITY_GROUP,
  TIME_ENTRY_SOURCE,
} from "@stll/api-contract";
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
// An entry without a classification hashes as it did before the field
// existed, so a stored pending batch keeps its fingerprint.
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

/**
 * The one classification rule for matter time entries: UTBMS codes only on
 * matters whose client bills in LEDES, otherwise the client activity group.
 * Internal entries have no matter, so no matter entry takes that group.
 */
export const matterClassificationAllowed = (
  classification: DesktopTimeEntryClassification,
  ledes: boolean,
) => {
  switch (classification.type) {
    case "ledes":
      return ledes;
    case "activity_group":
      return (
        !ledes &&
        classification.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT
      );
    default:
      return panic(
        "Unknown time entry classification",
        classification satisfies never,
      );
  }
};

/** Matter entries bill to the client, so only LEDES codes add fields to the
 * entry; the activity group is the default for a matter entry. */
const classificationCodes = (
  classification: DesktopTimeEntryClassification | undefined,
) =>
  classification?.type === "ledes"
    ? {
        taskCode: classification.taskCode,
        activityCode: classification.activityCode,
      }
    : {};

/** How a matter's client bills, as one read saw the matter and its client. */
type MatterBilling =
  | { type: "ledes" }
  | { type: "categories" }
  /** The matter names a client the caller cannot read. */
  | { type: "unknown" };

const matterBilling = ({
  clientId,
  client,
}: {
  clientId: string | null;
  client: { timeBillingFormat: string } | null;
}): MatterBilling => {
  if (clientId === null) {
    return { type: "categories" };
  }
  if (client === null) {
    return { type: "unknown" };
  }
  return client.timeBillingFormat === "ledes"
    ? { type: "ledes" }
    : { type: "categories" };
};

/**
 * The batch's active matters, each with its client's billing format. One
 * statement reads both, so the format cannot change between the two.
 */
const loadBatchMatters = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  matterIds: readonly string[],
) =>
  await tx.query.workspaces.findMany({
    where: {
      RAW: (table) =>
        sql`${table.id} IN (${sql.join(
          matterIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      organizationId: { eq: organizationId },
      status: { eq: "active" },
    },
    columns: { id: true, clientId: true },
    with: { client: { columns: { timeBillingFormat: true } } },
    limit: matterIds.length,
  });

/** Why a new batch's classifications do not fit its matters, or `null`. */
const classificationRefusal = (
  entries: DesktopTimeEntryBatch["entries"],
  matters: readonly {
    id: string;
    clientId: string | null;
    client: { timeBillingFormat: string } | null;
  }[],
): HandlerError | null => {
  const billingByMatter = new Map(
    matters.map((matter) => [matter.id, matterBilling(matter)]),
  );
  for (const { matterId, classification } of entries) {
    if (classification === undefined) {
      continue;
    }
    const billing =
      billingByMatter.get(matterId.toLowerCase()) ??
      panic("Authorized batch matter disappeared");
    if (billing.type === "unknown") {
      return new HandlerError({
        status: 409,
        message: "The matter's client is not available",
      });
    }
    if (
      !matterClassificationAllowed(classification, billing.type === "ledes")
    ) {
      return new HandlerError({
        status: 400,
        message: "Classification does not match the matter's billing format",
      });
    }
  }
  return null;
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
      const fingerprint = desktopBatchFingerprint(body);
      const normalizedEntries = body.entries.map(
        ({ matterId, classification, ...entry }) => ({
          ...entry,
          ...classificationCodes(classification),
          matterId: matterId.toLowerCase(),
        }),
      );
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
          const matters = await loadBatchMatters(
            tx,
            account.organizationId,
            requestedMatterIds,
          );
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
          // A replayed batch answers with its receipt; a new one is checked
          // against the billing format as it stands now.
          const refusal = classificationRefusal(body.entries, matters);
          if (refusal !== null) {
            return abortTransaction(refusal);
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
