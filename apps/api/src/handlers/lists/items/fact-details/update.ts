import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import {
  entities,
  legalListFactDetails,
  legalListItems,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FACT_CONFIDENCES,
  FACT_DATE_PRECISIONS,
  FACT_DETAIL_LIMITS,
  FACT_SCORING,
} from "@/api/lib/lists/fact-details";
import type { FactDatePrecision } from "@/api/lib/lists/fact-details";

const literals = <T extends string>(values: readonly T[]) =>
  t.Union(values.map((value) => t.Literal(value)));

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
  occurredOn: t.Nullable(
    t.Object({
      date: t.String({ format: "date" }),
      precision: literals(FACT_DATE_PRECISIONS),
    }),
  ),
  evidenceKind: t.Nullable(
    t.String({ minLength: 1, maxLength: FACT_DETAIL_LIMITS.EVIDENCE_KIND_MAX }),
  ),
  medium: t.Nullable(
    t.String({ minLength: 1, maxLength: FACT_DETAIL_LIMITS.MEDIUM_MAX }),
  ),
  confidence: literals(FACT_CONFIDENCES),
  interpretationNote: t.Nullable(
    t.String({
      minLength: 1,
      maxLength: FACT_DETAIL_LIMITS.INTERPRETATION_NOTE_MAX,
    }),
  ),
  scoring: literals(FACT_SCORING),
});

const config = {
  description:
    "Set the evidential detail of one fact item, replacing what it had: when " +
    "it happened (a date with day, month or year precision; a partial date " +
    "is stored as its first day), what kind of evidence and medium carry it, " +
    "how unambiguous its meaning is (confidence), a note where that meaning " +
    "is contested, and whether verifications may rely on it (`held` keeps it " +
    "out until confirmed). Only `fact` items carry detail.",
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
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
    const { listId, itemEntityId, occurredOn, ...detail } = body;
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
      safeDb(async (tx) => {
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

        const changes: FieldDiffs = {};
        for (const key of FACT_DETAIL_FIELDS) {
          const old = existing?.[key] ?? null;
          if (old !== values[key]) {
            changes[key] = { old, new: values[key] };
          }
        }
        if (existing !== undefined && Object.keys(changes).length === 0) {
          return { type: "unchanged" } as const;
        }

        const now = new Date();
        await tx
          .insert(legalListFactDetails)
          .values({
            itemEntityId,
            workspaceId,
            listId,
            ...values,
            updatedBy: user.id,
          })
          .onConflictDoUpdate({
            target: legalListFactDetails.itemEntityId,
            set: { ...values, updatedBy: user.id, updatedAt: now },
          });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          resourceId: itemEntityId,
          changes,
          metadata: { operation: "fact_details_set", listId },
        });
        return { type: "updated" } as const;
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
    return Result.ok({ itemEntityId, ...values });
  },
);

export default updateFactDetails;
