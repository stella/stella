import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { correspondence } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { readCorrespondenceProvenance } from "@/api/lib/email/correspondence/provenance";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandValidatedCorrespondenceCursorId } from "@/api/lib/safe-id-boundaries";

type CorrespondenceRow = typeof correspondence.$inferSelect;

const CORRESPONDENCE_LIST_COLUMNS = {
  id: correspondence.id,
  subject: correspondence.subject,
  from: correspondence.from,
  to: correspondence.to,
  cc: correspondence.cc,
  receivedAt: correspondence.receivedAt,
  sentAt: correspondence.sentAt,
  handlingState: correspondence.handlingState,
  assigneeId: correspondence.assigneeId,
  source: correspondence.source,
  sourceEntityId: correspondence.sourceEntityId,
  intake: correspondence.intake,
  originalSignature: correspondence.originalSignature,
  authenticatedSenderAddress: correspondence.authenticatedSenderAddress,
  spf: correspondence.spf,
  dkim: correspondence.dkim,
  dmarc: correspondence.dmarc,
  alignedIdentifier: correspondence.alignedIdentifier,
};

const UNPROJECTED_LIST_COLUMNS = [
  "entityFeatureGate", // RLS state is internal to the gate.
  "organizationId", // Tenant scope comes from the authorized session.
  "workspaceId", // Matter scope comes from the authorized route.
  "contentHash", // Internal content fingerprint for ingestion.
  "dedupKey", // Internal replay identity.
  "direction", // The compact list uses the detail route for direction metadata.
  "channel", // The compact list uses the detail route for channel metadata.
  "messageId", // Transport identifiers belong to detail.
  "inReplyTo", // Reply linkage belongs to detail.
  "references", // Thread references belong to detail.
  "bodyText", // Bodies are loaded only when opening a record.
  "bodyHtml", // HTML bodies are loaded only when opening a record.
  "createdAt", // List ordering and display use receivedAt.
  "updatedAt", // Record update timestamps belong to detail.
] as const satisfies readonly (keyof CorrespondenceRow)[];

type MissingListColumn = UnprojectedColumns<
  CorrespondenceRow,
  typeof CORRESPONDENCE_LIST_COLUMNS,
  (typeof UNPROJECTED_LIST_COLUMNS)[number]
>;
type UnexpectedListColumn = UnbackedProjectionKeys<
  CorrespondenceRow,
  typeof CORRESPONDENCE_LIST_COLUMNS,
  (typeof UNPROJECTED_LIST_COLUMNS)[number]
>;
true satisfies MissingListColumn extends never ? true : never;
true satisfies UnexpectedListColumn extends never ? true : never;

const PAGE_SIZE = 30;
const PAGE_SIZE_MAX = 100;
const cursorCodec = createTimestampIdCursorCodec({
  column: correspondence.receivedAt,
  brandId: brandValidatedCorrespondenceCursorId,
});

const config = {
  description:
    "List correspondence filed in a matter, newest received first. When intake is not direct, from, to, and the message date (sentAt) are asserted by the forwarder and are not verified; authentication verdicts in authenticatedSender describe the delivery, not the extracted original. A record whose source is upload was read from the email file sourceEntityId in the matter; its headers are as stated in that file and are not verified.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "correspondence",
    consumesServices: false,
  },
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
    const limit = normalizeTenantPageLimit(query.limit ?? PAGE_SIZE);
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .select({
              ...CORRESPONDENCE_LIST_COLUMNS,
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
          source,
          sourceEntityId,
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
            source,
            sourceEntityId,
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
