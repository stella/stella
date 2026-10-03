import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { correspondenceDropLogs } from "@/api/db/schema";
import {
  ACCOUNT_ACCESS,
  createSafeHandler,
  type WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedCorrespondenceDropId } from "@/api/lib/safe-id-boundaries";

type CorrespondenceDropRow = typeof correspondenceDropLogs.$inferSelect;

const DROP_COLUMNS = {
  id: correspondenceDropLogs.id,
  senderAddress: correspondenceDropLogs.senderAddress,
  receivedAt: correspondenceDropLogs.receivedAt,
  reason: correspondenceDropLogs.reason,
};

const UNPROJECTED_DROP_COLUMNS = [
  "organizationId", // The authorized session determines the organization.
  "workspaceId", // The authorized route already identifies the matter.
] as const satisfies readonly (keyof CorrespondenceDropRow)[];

type MissingDropColumn = UnprojectedColumns<
  CorrespondenceDropRow,
  typeof DROP_COLUMNS,
  (typeof UNPROJECTED_DROP_COLUMNS)[number]
>;
type UnexpectedDropColumn = UnbackedProjectionKeys<
  CorrespondenceDropRow,
  typeof DROP_COLUMNS,
  (typeof UNPROJECTED_DROP_COLUMNS)[number]
>;
true satisfies MissingDropColumn extends never ? true : never;
true satisfies UnexpectedDropColumn extends never ? true : never;

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const cursorCodec = createTimestampIdCursorCodec({
  column: correspondenceDropLogs.receivedAt,
  brandId: brandPersistedCorrespondenceDropId,
});
const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "document_processing" },
  access: "read",
  query: t.Object({
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  }),
} satisfies WorkspaceHandlerConfig;

export default createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId, session }) {
    const limit = normalizeTenantPageLimit(query.limit ?? DEFAULT_PAGE_SIZE);
    const cursor =
      query.cursor === undefined ? null : cursorCodec.decode(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid pagination cursor" }),
      );
    }
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .select({
              ...DROP_COLUMNS,
              cursorTimestamp: cursorCodec.cursorValue,
            })
            .from(correspondenceDropLogs)
            .where(
              and(
                eq(correspondenceDropLogs.workspaceId, workspaceId),
                eq(
                  correspondenceDropLogs.organizationId,
                  session.activeOrganizationId,
                ),
                cursor === null
                  ? undefined
                  : cursorCodec.keysetAfter({
                      cursor,
                      idColumn: correspondenceDropLogs.id,
                      direction: "descending",
                    }),
              ),
            )
            .orderBy(
              desc(correspondenceDropLogs.receivedAt),
              desc(correspondenceDropLogs.id),
            )
            .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: ({ cursorTimestamp, id }) =>
        cursorCodec.encode(cursorTimestamp, id),
    });
    return Result.ok({
      ...page,
      items: page.items.map(({ id, senderAddress, receivedAt, reason }) => ({
        id,
        sender: senderAddress,
        receivedAt,
        reason,
        setupHint:
          reason === "authentication_failed"
            ? ("configure_sender_spf_dkim_dmarc" as const)
            : null,
      })),
    });
  },
);
