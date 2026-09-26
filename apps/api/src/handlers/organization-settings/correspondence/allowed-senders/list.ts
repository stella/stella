import { panic, Result } from "better-result";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandValidatedAllowedSenderCursorId } from "@/api/lib/safe-id-boundaries";

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;
const MAX_MATTERS_PER_SENDER = 200;
const querySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: PAGE_SIZE_MAX })),
  cursor: t.Optional(tPaginationCursor()),
});

const config = {
  description:
    "List approved and revoked shared mailbox senders for the active organization.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "correspondence" },
  query: querySchema,
} satisfies HandlerConfig;

const listAllowedSenders = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const limit = query.limit ?? PAGE_SIZE_DEFAULT;
    const cursorParts = query.cursor
      ? decodePaginationCursor(query.cursor)
      : null;
    const rawCursor = cursorParts?.at(0);
    if (
      query.cursor &&
      (!isUuidPaginationCursorPart(rawCursor) || cursorParts.length !== 1)
    ) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursor = isUuidPaginationCursorPart(rawCursor)
      ? brandValidatedAllowedSenderCursorId(rawCursor)
      : null;

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const conditions = [
          eq(
            correspondenceAllowedSenders.organizationId,
            session.activeOrganizationId,
          ),
          eq(correspondenceAllowedSenders.kind, "shared_mailbox"),
        ];
        if (cursor !== null) {
          conditions.push(gt(correspondenceAllowedSenders.id, cursor));
        }
        const rows = await tx
          .select({
            id: correspondenceAllowedSenders.id,
            address: correspondenceAllowedSenders.address,
            scope: correspondenceAllowedSenders.scope,
            approvedBy: correspondenceAllowedSenders.approvedBy,
            approvedAt: correspondenceAllowedSenders.approvedAt,
            revokedAt: correspondenceAllowedSenders.revokedAt,
          })
          .from(correspondenceAllowedSenders)
          .where(and(...conditions))
          .orderBy(asc(correspondenceAllowedSenders.id))
          .limit(limit + 1);

        const senderIds = rows.slice(0, limit).map(({ id }) => id);
        const matterRows =
          senderIds.length === 0
            ? []
            : await tx
                .select({
                  allowedSenderId:
                    correspondenceAllowedSenderMatters.allowedSenderId,
                  workspaceId: correspondenceAllowedSenderMatters.workspaceId,
                })
                .from(correspondenceAllowedSenderMatters)
                .where(
                  and(
                    eq(
                      correspondenceAllowedSenderMatters.organizationId,
                      session.activeOrganizationId,
                    ),
                    inArray(
                      correspondenceAllowedSenderMatters.allowedSenderId,
                      senderIds,
                    ),
                  ),
                )
                .orderBy(asc(correspondenceAllowedSenderMatters.workspaceId))
                .limit(PAGE_SIZE_MAX * MAX_MATTERS_PER_SENDER + 1);

        return { rows, matterRows };
      }),
    );

    const page = createCursorPage({
      rows: result.rows,
      limit,
      cursorForItem: ({ id }) => encodePaginationCursor([id]),
    });
    if (result.matterRows.length > PAGE_SIZE_MAX * MAX_MATTERS_PER_SENDER) {
      return panic("Allowed sender matter scope exceeds the bounded page");
    }
    const workspaceIdsBySender = new Map<string, string[]>();
    for (const row of result.matterRows) {
      const workspaceIds = workspaceIdsBySender.get(row.allowedSenderId) ?? [];
      workspaceIds.push(row.workspaceId);
      workspaceIdsBySender.set(row.allowedSenderId, workspaceIds);
    }
    return Result.ok({
      ...page,
      items: page.items.map((row) => ({
        id: row.id,
        address: row.address,
        scope: row.scope,
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt,
        revokedAt: row.revokedAt,
        matterIds: workspaceIdsBySender.get(row.id) ?? [],
        active: row.revokedAt === null,
      })),
    });
  },
);

export default listAllowedSenders;
