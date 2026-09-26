import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { correspondenceDropLogs } from "@/api/db/schema";
import {
  createSafeHandler,
  type WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedCorrespondenceDropId } from "@/api/lib/safe-id-boundaries";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const cursorCodec = createTimestampIdCursorCodec({
  column: correspondenceDropLogs.receivedAt,
  brandId: brandPersistedCorrespondenceDropId,
});
const config = {
  permissions: { workspace: ["read"] },
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
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
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
              id: correspondenceDropLogs.id,
              sender: correspondenceDropLogs.senderAddress,
              receivedAt: correspondenceDropLogs.receivedAt,
              reason: correspondenceDropLogs.reason,
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
      items: page.items.map(({ id, sender, receivedAt, reason }) => ({
        id,
        sender,
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
