import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { flowDefinitions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedFlowDefinitionId } from "@/api/lib/safe-id-boundaries";

// ── List ────────────────────────────────────────────────

const decodeFlowDefinitionCursor = (
  cursor: string,
): SafeId<"flowDefinition"> | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }
  const [rawId] = parts;
  if (!isUuidPaginationCursorPart(rawId)) {
    return null;
  }
  return brandPersistedFlowDefinitionId(rawId);
};

type ListFlowDefinitionsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  query: { limit?: number; cursor?: string };
};

export const listFlowDefinitionsHandler = async function* ({
  safeDb,
  organizationId,
  query,
}: ListFlowDefinitionsProps) {
  const limit = query.limit ?? LIMITS.flowDefinitionsPageSizeDefault;
  const conditions = [eq(flowDefinitions.organizationId, organizationId)];

  if (query.cursor) {
    const cursor = decodeFlowDefinitionCursor(query.cursor);
    if (!cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const boundary = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowDefinitions.findFirst({
          where: {
            id: { eq: cursor },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );
    if (!boundary) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    conditions.push(
      sql`(${flowDefinitions.createdAt}, ${flowDefinitions.id}) < (select b.created_at, b.id from flow_definitions b where b.id = ${cursor} and b.organization_id = ${organizationId})`,
    );
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: flowDefinitions.id,
          name: flowDefinitions.name,
          description: flowDefinitions.description,
          steps: flowDefinitions.steps,
          trigger: flowDefinitions.trigger,
          enabled: flowDefinitions.enabled,
          createdAt: flowDefinitions.createdAt,
          updatedAt: flowDefinitions.updatedAt,
        })
        .from(flowDefinitions)
        .where(and(...conditions))
        .orderBy(desc(flowDefinitions.createdAt), desc(flowDefinitions.id))
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });

  return Result.ok({
    ...page,
    items: page.items.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      triggerType: row.trigger.type,
      stepCount: row.steps.length,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
};

// ── Get ─────────────────────────────────────────────────

type GetFlowDefinitionProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  flowId: SafeId<"flowDefinition">;
};

export const getFlowDefinitionHandler = async function* ({
  safeDb,
  organizationId,
  flowId,
}: GetFlowDefinitionProps) {
  const definition = yield* Result.await(
    safeDb((tx) =>
      tx.query.flowDefinitions.findFirst({
        where: {
          id: { eq: flowId },
          organizationId: { eq: organizationId },
        },
        columns: {
          id: true,
          name: true,
          description: true,
          steps: true,
          trigger: true,
          enabled: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ),
  );

  if (!definition) {
    return Result.err(
      new HandlerError({ status: 404, message: "Flow not found" }),
    );
  }

  return Result.ok({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    steps: definition.steps,
    trigger: definition.trigger,
    enabled: definition.enabled,
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
  });
};
