import { panic, Result } from "better-result";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandValidatedAllowedSenderCursorId } from "@/api/lib/safe-id-boundaries";

type AllowedSenderRow = typeof correspondenceAllowedSenders.$inferSelect;

const ALLOWED_SENDER_COLUMNS = {
  id: correspondenceAllowedSenders.id,
  address: correspondenceAllowedSenders.address,
  scope: correspondenceAllowedSenders.scope,
  approvedBy: correspondenceAllowedSenders.approvedBy,
  approvedAt: correspondenceAllowedSenders.approvedAt,
  revokedAt: correspondenceAllowedSenders.revokedAt,
};

const UNPROJECTED_ALLOWED_SENDER_COLUMNS = [
  "organizationId", // The active organization scopes this list.
  "kind", // The query only returns shared mailboxes.
  "ownerUserId", // Personal sender ownership is outside the shared mailbox list.
  "approvedByDisplay", // Historical profile snapshots are exposed only through correspondence attribution.
] as const satisfies readonly (keyof AllowedSenderRow)[];

type MissingAllowedSenderRowColumn = UnprojectedColumns<
  AllowedSenderRow,
  typeof ALLOWED_SENDER_COLUMNS,
  (typeof UNPROJECTED_ALLOWED_SENDER_COLUMNS)[number]
>;
type UnexpectedAllowedSenderRowColumn = UnbackedProjectionKeys<
  AllowedSenderRow,
  typeof ALLOWED_SENDER_COLUMNS,
  (typeof UNPROJECTED_ALLOWED_SENDER_COLUMNS)[number]
>;
true satisfies MissingAllowedSenderRowColumn extends never ? true : never;
true satisfies UnexpectedAllowedSenderRowColumn extends never ? true : never;

type AllowedSenderMatterRow =
  typeof correspondenceAllowedSenderMatters.$inferSelect;

const ALLOWED_SENDER_MATTER_COLUMNS = {
  allowedSenderId: correspondenceAllowedSenderMatters.allowedSenderId,
  workspaceId: correspondenceAllowedSenderMatters.workspaceId,
};

const UNPROJECTED_ALLOWED_SENDER_MATTER_COLUMNS = [
  "id", // Scope memberships are exposed as matter identifiers, not association rows.
  "organizationId", // The active organization scopes the selected relationships.
] as const satisfies readonly (keyof AllowedSenderMatterRow)[];

type MissingAllowedSenderMatterRowColumn = UnprojectedColumns<
  AllowedSenderMatterRow,
  typeof ALLOWED_SENDER_MATTER_COLUMNS,
  (typeof UNPROJECTED_ALLOWED_SENDER_MATTER_COLUMNS)[number]
>;
type UnexpectedAllowedSenderMatterRowColumn = UnbackedProjectionKeys<
  AllowedSenderMatterRow,
  typeof ALLOWED_SENDER_MATTER_COLUMNS,
  (typeof UNPROJECTED_ALLOWED_SENDER_MATTER_COLUMNS)[number]
>;
true satisfies MissingAllowedSenderMatterRowColumn extends never ? true : never;
true satisfies UnexpectedAllowedSenderMatterRowColumn extends never
  ? true
  : never;

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
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: {
    type: "capability",
    reason: "correspondence",
    consumesServices: false,
  },
  query: querySchema,
} satisfies HandlerConfig;

const listAllowedSenders = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const limit = normalizeTenantPageLimit(query.limit ?? PAGE_SIZE_DEFAULT);
    const cursorParts = query.cursor
      ? decodePaginationCursor(query.cursor)
      : null;
    const rawCursor = cursorParts?.at(0);
    if (
      query.cursor &&
      (cursorParts === null ||
        !isUuidPaginationCursorPart(rawCursor) ||
        cursorParts.length !== 1)
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
          .select(ALLOWED_SENDER_COLUMNS)
          .from(correspondenceAllowedSenders)
          .where(and(...conditions))
          .orderBy(asc(correspondenceAllowedSenders.id))
          .limit(limit + 1);

        const senderIds = rows.slice(0, limit).map(({ id }) => id);
        const matterRows =
          senderIds.length === 0
            ? []
            : await tx
                .select(ALLOWED_SENDER_MATTER_COLUMNS)
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
    const workspaceIdsBySender = new Map<
      SafeId<"correspondenceAllowedSender">,
      SafeId<"workspace">[]
    >(page.items.map(({ id }) => [id, []]));
    for (const row of result.matterRows) {
      const workspaceIds =
        workspaceIdsBySender.get(row.allowedSenderId) ??
        panic("Matter scope has no sender on this page");
      workspaceIds.push(row.workspaceId);
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
        matterIds:
          workspaceIdsBySender.get(row.id) ??
          panic("Sender page has no initialized matter scope"),
        active: row.revokedAt === null,
      })),
    });
  },
);

export default listAllowedSenders;
