import { Result, panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { abortableTx, abortTransaction } from "@/api/db/safe-db";
import {
  entities,
  legalListFactDetails,
  legalListItems,
} from "@/api/db/schema";
import { legalListRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  FACT_CONFIDENCES,
  FACT_DATE_PRECISIONS,
  FACT_DETAIL_LIMITS,
  FACT_SCORING,
} from "@/api/lib/lists/fact-details";
import type { FactDatePrecision } from "@/api/lib/lists/fact-details";
import { LIST_VERIFICATION_ITEM_OPERATION } from "@/api/lib/lists/item-operations";
import {
  expectedUpdatedAtSchema,
  VERSION_CONFLICT_ERROR_CODE,
} from "@/api/lib/optimistic-concurrency";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { enforceWritePrecondition } from "@/api/lib/write-contract";

// `t.UnionEnum` over the const tuples keeps the literal unions in the
// inferred body type, which the web client reads its types from.

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
  occurredOn: t.Nullable(
    t.Object({
      date: t.String({ format: "date" }),
      precision: t.UnionEnum(FACT_DATE_PRECISIONS),
    }),
  ),
  evidenceKind: t.Nullable(
    t.String({ minLength: 1, maxLength: FACT_DETAIL_LIMITS.EVIDENCE_KIND_MAX }),
  ),
  medium: t.Nullable(
    t.String({ minLength: 1, maxLength: FACT_DETAIL_LIMITS.MEDIUM_MAX }),
  ),
  confidence: t.UnionEnum(FACT_CONFIDENCES),
  interpretationNote: t.Nullable(
    t.String({
      minLength: 1,
      maxLength: FACT_DETAIL_LIMITS.INTERPRETATION_NOTE_MAX,
    }),
  ),
  scoring: t.UnionEnum(FACT_SCORING),
  expectedUpdatedAt: t.Nullable(expectedUpdatedAtSchema),
});

const config = {
  contract: "replace",
  precondition: {
    type: "updatedAt",
    field: "expectedUpdatedAt",
  },
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Set the evidential detail of one fact item, replacing what it had: when " +
    "it happened (a date with day, month or year precision; a partial date " +
    "is stored as its first day), what kind of evidence and medium carry it, " +
    "how unambiguous its meaning is (confidence), a note where that meaning " +
    "is contested, and whether verifications may rely on it (`held` keeps it " +
    "out until confirmed). Only `fact` items carry detail.",
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: legalListRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const FACT_DETAIL_FIELDS = [
  "occurredOn",
  "occurredOnPrecision",
  "evidenceKind",
  "medium",
  "confidence",
  "interpretationNote",
  "scoring",
] as const satisfies readonly (keyof typeof legalListFactDetails.$inferSelect)[];
const ABSENT_FACT_DETAILS_UPDATED_AT = new Date(0);
const ABSENT_FACT_DETAILS_EXPECTED_UPDATED_AT =
  ABSENT_FACT_DETAILS_UPDATED_AT.toISOString();

/** A partial date has one spelling: its first day. */
const canonicalDate = (date: string, precision: FactDatePrecision): string => {
  switch (precision) {
    case "day": {
      return date;
    }
    case "month": {
      return `${date.slice(0, 7)}-01`;
    }
    case "year": {
      return `${date.slice(0, 4)}-01-01`;
    }
    default: {
      precision satisfies never;
      return panic(`Unhandled date precision: ${String(precision)}`);
    }
  }
};

const updateFactDetails = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const { listId, itemEntityId, occurredOn, expectedUpdatedAt, ...detail } =
      body;
    const values = {
      ...detail,
      ...(occurredOn === null
        ? { occurredOn: null, occurredOnPrecision: null }
        : {
            occurredOn: canonicalDate(occurredOn.date, occurredOn.precision),
            occurredOnPrecision: occurredOn.precision,
          }),
    };

    const result = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const item = (
          await tx
            .select({ listItemType: entities.listItemType })
            .from(legalListItems)
            .innerJoin(
              entities,
              and(
                eq(entities.id, legalListItems.entityId),
                eq(entities.workspaceId, legalListItems.workspaceId),
              ),
            )
            .where(
              and(
                eq(legalListItems.entityId, itemEntityId),
                eq(legalListItems.listId, listId),
                eq(legalListItems.workspaceId, workspaceId),
              ),
            )
            .limit(1)
        ).at(0);
        if (item === undefined) {
          return { type: "not-found" } as const;
        }
        if (item.listItemType !== LIST_ITEM_TYPE.FACT) {
          return { type: "not-a-fact" } as const;
        }

        const existing = (
          await tx
            .select()
            .from(legalListFactDetails)
            .where(
              and(
                eq(legalListFactDetails.itemEntityId, itemEntityId),
                eq(legalListFactDetails.workspaceId, workspaceId),
              ),
            )
            .limit(1)
            .for("update")
        ).at(0);

        const conflict = enforceWritePrecondition({
          type: "updatedAt",
          field: "expectedUpdatedAt",
          storedUpdatedAt:
            existing?.updatedAt ?? ABSENT_FACT_DETAILS_UPDATED_AT,
          expectedUpdatedAt:
            expectedUpdatedAt ?? ABSENT_FACT_DETAILS_EXPECTED_UPDATED_AT,
          resource: "Fact details",
        });
        if (conflict !== null) {
          return abortTransaction(conflict);
        }

        const changes: FieldDiffs = {};
        for (const key of FACT_DETAIL_FIELDS) {
          const old = existing?.[key] ?? null;
          if (old !== values[key]) {
            changes[key] = { old, new: values[key] };
          }
        }
        if (existing !== undefined && Object.keys(changes).length === 0) {
          return { type: "unchanged", updatedAt: existing.updatedAt } as const;
        }

        const written = (
          existing === undefined
            ? await tx
                .insert(legalListFactDetails)
                .values({
                  itemEntityId,
                  workspaceId,
                  listId,
                  ...values,
                  updatedBy: user.id,
                })
                .onConflictDoNothing({
                  target: legalListFactDetails.itemEntityId,
                })
                .returning({ updatedAt: legalListFactDetails.updatedAt })
            : await tx
                .update(legalListFactDetails)
                .set({
                  ...values,
                  updatedBy: user.id,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(
                  and(
                    eq(legalListFactDetails.itemEntityId, itemEntityId),
                    eq(legalListFactDetails.workspaceId, workspaceId),
                  ),
                )
                .returning({ updatedAt: legalListFactDetails.updatedAt })
        ).at(0);
        if (written === undefined) {
          if (existing !== undefined) {
            return panic("Locked fact details disappeared");
          }
          return abortTransaction(
            new HandlerError({
              code: VERSION_CONFLICT_ERROR_CODE,
              status: 409,
              message:
                "Fact details changed while it was being edited; reload and try again",
            }),
          );
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          resourceId: itemEntityId,
          changes,
          metadata: {
            operation: LIST_VERIFICATION_ITEM_OPERATION.factDetailsSet,
            listId,
          },
        });
        return { type: "updated", updatedAt: written.updatedAt } as const;
      }),
    );

    if (result.type === "not-found") {
      return Result.err(
        new HandlerError({ status: 404, message: "List item not found" }),
      );
    }
    if (result.type === "not-a-fact") {
      return Result.err(
        new HandlerError({
          status: 422,
          message:
            "Only fact items carry evidential detail; change the item type to `fact` first.",
        }),
      );
    }
    const projected: FactDetailsProjection = {
      itemEntityId,
      ...values,
      updatedAt: result.updatedAt,
    };
    return Result.ok(projected);
  },
);

type FactDetailsRow = typeof legalListFactDetails.$inferSelect;
type FactDetailsProjection = Pick<
  FactDetailsRow,
  "itemEntityId" | "updatedAt" | (typeof FACT_DETAIL_FIELDS)[number]
>;

const UNPROJECTED_FACT_DETAIL_COLUMNS = [
  "entityFeatureGate", // RLS state is internal to the gate.
  // Scope keys the caller sent in the request.
  "workspaceId",
  "listId",
  // Bookkeeping: who last saved and when is in the audit trail.
  "updatedBy",
  "createdAt",
] as const satisfies readonly (keyof FactDetailsRow)[];

type MissingProjectedFactDetailColumn = UnprojectedColumns<
  FactDetailsRow,
  FactDetailsProjection,
  (typeof UNPROJECTED_FACT_DETAIL_COLUMNS)[number]
>;
type UnexpectedProjectedFactDetailColumn = UnbackedProjectionKeys<
  FactDetailsRow,
  FactDetailsProjection,
  (typeof UNPROJECTED_FACT_DETAIL_COLUMNS)[number]
>;

true satisfies MissingProjectedFactDetailColumn extends never ? true : never;
true satisfies UnexpectedProjectedFactDetailColumn extends never ? true : never;

export default updateFactDetails;
