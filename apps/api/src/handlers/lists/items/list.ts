import { Result, panic } from "better-result";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  fields,
  legalListColumns,
  legalListFactDetails,
  legalListItemSources,
  legalListItems,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { projectListFactDetails } from "@/api/lib/auth/feature-access/list-eligibility";
import { avtViewAccessStatus } from "@/api/lib/auth/feature-access/view-eligibility";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

const paramsSchema = workspaceParams({ listId: tSafeId("legalList") });
const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.legalListItemsPageSizeMax }),
  ),
  cursor: t.Optional(tPaginationCursor()),
});

const config = {
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "List one list's items in list order with cursor pagination. Each item " +
    "carries its name, item type, task status, priority, due date, section, " +
    "position, description, and review status, plus the values it holds for " +
    "the properties the list binds as columns. A fact item also carries its " +
    "evidential detail (date and precision, evidence kind, medium, " +
    "confidence and interpretation note), null until it is set, and " +
    "its first source (document id, document name, locator), null when it " +
    "has none.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: paramsSchema,
  query: querySchema,
} satisfies WorkspaceHandlerConfig;

const sourceDocument = alias(entities, "source_document");

type ItemCursor = { position: string; id: SafeId<"entity"> };

const decodeCursor = (value: string): ItemCursor | null => {
  const parts = decodePaginationCursor(value);
  const position = parts?.at(0);
  const id = parts?.at(1);
  if (typeof position !== "string" || !isUuidPaginationCursorPart(id)) {
    return null;
  }
  return { position, id: brandPersistedEntityId(id) };
};

type ReadListPropertyIdsOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  listId: SafeId<"legalList">;
};

const readListPropertyIds = async ({
  tx,
  workspaceId,
  listId,
}: ReadListPropertyIdsOptions) => {
  const columns = await readBounded(
    tx
      .select({ propertyId: legalListColumns.propertyId })
      .from(legalListColumns)
      .where(
        and(
          eq(legalListColumns.workspaceId, workspaceId),
          eq(legalListColumns.listId, listId),
        ),
      )
      .orderBy(asc(legalListColumns.position)),
    LIMITS.legalListColumnsPerList,
  );
  switch (columns.type) {
    case "complete":
      return columns.rows.map((column) => column.propertyId);
    case "overflow":
      return panic("List columns exceed the per-list limit", {
        listId,
        cap: columns.cap,
      });
    default:
      columns satisfies never;
      return panic("Unexpected bounded list column result");
  }
};

const readListItems = createSafeHandler(config, async function* (context) {
  const { safeDb, workspaceId, params, query } = context;
  const accessStatus = avtViewAccessStatus({
    snapshot: context.featureAccessSnapshot,
    organizationId: context.session.activeOrganizationId,
    userId: context.user.id,
  });
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.legalListItemsPageSizeDefault,
  );
  const conditions = [
    eq(legalListItems.workspaceId, workspaceId),
    eq(legalListItems.listId, params.listId),
  ];

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursorCondition = or(
      gt(legalListItems.position, cursor.position),
      and(
        eq(legalListItems.position, cursor.position),
        gt(legalListItems.entityId, cursor.id),
      ),
    );
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  const result = yield* Result.await(
    safeDb(async (tx) => {
      const list = await tx.query.legalLists.findFirst({
        where: {
          id: { eq: params.listId },
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true },
      });
      if (!list) {
        return null;
      }

      const firstSource = tx
        .select({
          documentId: legalListItemSources.sourceEntityId,
          documentName: sourceDocument.name,
          locator: legalListItemSources.locator,
        })
        .from(legalListItemSources)
        .innerJoin(
          sourceDocument,
          and(
            eq(sourceDocument.id, legalListItemSources.sourceEntityId),
            eq(sourceDocument.workspaceId, legalListItemSources.workspaceId),
          ),
        )
        .where(
          and(
            eq(legalListItemSources.workspaceId, workspaceId),
            eq(legalListItemSources.itemEntityId, legalListItems.entityId),
            eq(legalListItemSources.listId, legalListItems.listId),
            ne(legalListItemSources.verificationStatus, "rejected"),
          ),
        )
        .orderBy(
          asc(legalListItemSources.createdAt),
          asc(legalListItemSources.id),
        )
        .limit(1)
        .as("first_source");

      const [rows, propertyIds] = await Promise.all([
        tx
          .select({
            id: entities.id,
            name: entities.name,
            itemType: entities.listItemType,
            status: entities.status,
            priority: entities.priority,
            dueDate: entities.dueDate,
            sectionId: legalListItems.sectionId,
            position: legalListItems.position,
            description: legalListItems.description,
            reviewStatus: legalListItems.reviewStatus,
            createdAt: legalListItems.createdAt,
            updatedAt: legalListItems.updatedAt,
            // Drizzle reads a left-joined object as absent when its first
            // column is null, so a non-null column must lead.
            factDetails: {
              confidence: legalListFactDetails.confidence,
              occurredOn: legalListFactDetails.occurredOn,
              occurredOnPrecision: legalListFactDetails.occurredOnPrecision,
              evidenceKind: legalListFactDetails.evidenceKind,
              medium: legalListFactDetails.medium,
              interpretationNote: legalListFactDetails.interpretationNote,
              scoring: legalListFactDetails.scoring,
            },
            firstSource: {
              documentId: firstSource.documentId,
              documentName: firstSource.documentName,
              locator: firstSource.locator,
            },
          })
          .from(legalListItems)
          .innerJoin(
            entities,
            and(
              eq(entities.id, legalListItems.entityId),
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "task"),
            ),
          )
          // At most one detail row per item (keyed by the item), so the
          // join never multiplies the page.
          .leftJoin(
            legalListFactDetails,
            and(
              eq(legalListFactDetails.itemEntityId, legalListItems.entityId),
              eq(legalListFactDetails.workspaceId, workspaceId),
            ),
          )
          .leftJoinLateral(firstSource, sql`true`)
          .where(and(...conditions))
          .orderBy(asc(legalListItems.position), asc(legalListItems.entityId))
          .limit(limit + 1),
        readListPropertyIds({ tx, workspaceId, listId: params.listId }),
      ]);
      const entityIds = rows.map((row) => row.id);
      if (entityIds.length === 0 || propertyIds.length === 0) {
        return rows.map((row) => Object.assign(row, { customFields: [] }));
      }
      const fieldRows = await tx
        .select({
          entityId: entities.id,
          propertyId: fields.propertyId,
          content: fields.content,
        })
        .from(fields)
        .innerJoin(
          entities,
          and(
            eq(entities.currentVersionId, fields.entityVersionId),
            eq(entities.workspaceId, workspaceId),
            inArray(entities.id, entityIds),
          ),
        )
        .where(
          and(
            eq(fields.workspaceId, workspaceId),
            inArray(fields.propertyId, propertyIds),
          ),
        );
      // Seeded with every page row so an item without field values still
      // has an entry and a miss on lookup is an invariant breach.
      const fieldsByEntity = new Map<string, typeof fieldRows>(
        entityIds.map((id) => [id, []]),
      );
      for (const field of fieldRows) {
        (
          fieldsByEntity.get(field.entityId) ??
          panic(`Field for unselected entity ${field.entityId}`)
        ).push(field);
      }
      return rows.map((row) =>
        Object.assign(row, {
          customFields:
            fieldsByEntity.get(row.id) ??
            panic(`Entity ${row.id} missing from field grouping`),
        }),
      );
    }),
  );

  if (!result) {
    return Result.err(
      new HandlerError({ status: 404, message: "List not found" }),
    );
  }

  return Result.ok(
    createCursorPage({
      rows: result.map((row) => ({
        ...row,
        factDetails: projectListFactDetails(row.factDetails, accessStatus),
      })),
      limit,
      cursorForItem: (item) => encodePaginationCursor([item.position, item.id]),
    }),
  );
});

export default readListItems;
