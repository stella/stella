import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { correspondence } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { readCorrespondenceProvenance } from "@/api/lib/email/correspondence/provenance";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import { brandValidatedCorrespondenceCursorId } from "@/api/lib/safe-id-boundaries";

const PAGE_SIZE = 30;
const PAGE_SIZE_MAX = 100;
const cursorCodec = createTimestampIdCursorCodec({
  column: correspondence.receivedAt,
  brandId: brandValidatedCorrespondenceCursorId,
});

const config = {
  description:
    "List correspondence filed in a matter, newest received first. When intake is not direct, from, to, and the message date (sentAt) are asserted by the forwarder and are not verified; authentication verdicts in authenticatedSender describe the delivery, not the extracted original.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "correspondence" },
  access: "read",
  query: t.Object({
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: PAGE_SIZE_MAX })),
  }),
} satisfies WorkspaceHandlerConfig;

const listCorrespondence = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    const cursor =
      query.cursor === undefined ? null : cursorCodec.decode(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid correspondence cursor",
        }),
      );
    }
    const limit = query.limit ?? PAGE_SIZE;
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .select({
              id: correspondence.id,
              subject: correspondence.subject,
              from: correspondence.from,
              to: correspondence.to,
              cc: correspondence.cc,
              receivedAt: correspondence.receivedAt,
              sentAt: correspondence.sentAt,
              handlingState: correspondence.handlingState,
              assigneeId: correspondence.assigneeId,
              intake: correspondence.intake,
              originalSignature: correspondence.originalSignature,
              authenticatedSenderAddress:
                correspondence.authenticatedSenderAddress,
              spf: correspondence.spf,
              dkim: correspondence.dkim,
              dmarc: correspondence.dmarc,
              alignedIdentifier: correspondence.alignedIdentifier,
              cursorTimestamp: cursorCodec.cursorValue,
            })
            .from(correspondence)
            .where(
              and(
                eq(correspondence.workspaceId, workspaceId),
                cursor === null
                  ? undefined
                  : cursorCodec.keysetAfter({
                      cursor,
                      idColumn: correspondence.id,
                      direction: "descending",
                    }),
              ),
            )
            .orderBy(desc(correspondence.receivedAt), desc(correspondence.id))
            .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (row) => cursorCodec.encode(row.cursorTimestamp, row.id),
    });
    return Result.ok({
      items: page.items.map(
        ({
          cursorTimestamp: _cursorTimestamp,
          intake,
          originalSignature,
          authenticatedSenderAddress,
          spf,
          dkim,
          dmarc,
          alignedIdentifier,
          ...record
        }) => ({
          ...record,
          ...readCorrespondenceProvenance({
            intake,
            originalSignature,
            authenticatedSenderAddress,
            spf,
            dkim,
            dmarc,
            alignedIdentifier,
          }),
        }),
      ),
      nextCursor: page.nextCursor,
      limit,
    });
  },
);

export default listCorrespondence;
