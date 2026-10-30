import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { outboundActions } from "@/api/db/schema";
import { readStoredOutboundPreview } from "@/api/handlers/outbound-actions/store";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type OutboundActionRow = typeof outboundActions.$inferSelect;

const UNPROJECTED_OUTBOUND_ACTION_COLUMNS = [
  // Authorization scope is resolved on the server.
  "organizationId",
  "userId",
  // Chat provenance is not part of the confirmation contract.
  "chatThreadId",
  // The client receives the decrypted preview, never its storage envelope.
  "previewEncrypted",
  "previewIv",
  // Internal lifecycle timestamps; the card uses expiration and completion.
  "confirmedAt",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof OutboundActionRow)[];

const config = {
  contract: "patch",
  permissions: { integration: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "human_confirmation" },
  access: "read",
  params: v.object({ actionId: resourceIdSchema("outboundAction") }),
} satisfies HandlerConfig;

/**
 * The preview card's content: the stored preview (never the assistant's
 * arguments), its hash for the confirm, and where the action stands.
 */
const readOutboundAction = createSafeRootHandler(
  config,
  async function* ({ params: { actionId }, safeDb, session, user }) {
    const organizationId = session.activeOrganizationId;
    const action = yield* Result.await(
      safeDb(async (tx) =>
        (
          await tx
            .select({
              id: outboundActions.id,
              kind: outboundActions.kind,
              status: outboundActions.status,
              expiresAt: outboundActions.expiresAt,
              // Same clock as the confirm claim, so read never disagrees.
              expired: sql<boolean>`${outboundActions.expiresAt} <= clock_timestamp()`,
              previewEncrypted: outboundActions.previewEncrypted,
              previewIv: outboundActions.previewIv,
              previewHash: outboundActions.previewHash,
              providerMessageId: outboundActions.providerMessageId,
              failureCode: outboundActions.failureCode,
              completedAt: outboundActions.completedAt,
            })
            .from(outboundActions)
            .where(
              and(
                eq(outboundActions.id, actionId),
                eq(outboundActions.organizationId, organizationId),
                eq(outboundActions.userId, user.id),
              ),
            )
            .limit(1)
        ).at(0),
      ),
    );
    if (!action) {
      return Result.err(
        new HandlerError({ status: 404, message: "Prepared action not found" }),
      );
    }
    const preview = yield* Result.await(
      readStoredOutboundPreview({
        organizationId,
        previewEncrypted: action.previewEncrypted,
        previewHash: action.previewHash,
        previewIv: action.previewIv,
      }),
    );
    const expired = action.status === "pending" && action.expired;
    const payload = {
      id: action.id,
      kind: action.kind,
      status: expired ? ("expired" as const) : action.status,
      preview,
      previewHash: action.previewHash,
      expiresAt: action.expiresAt,
      providerMessageId: action.providerMessageId,
      failureCode: action.failureCode,
      completedAt: action.completedAt,
    };
    type StoredProjection = Omit<typeof payload, "preview">;
    type ExcusedColumn = (typeof UNPROJECTED_OUTBOUND_ACTION_COLUMNS)[number];
    true satisfies UnprojectedColumns<
      OutboundActionRow,
      StoredProjection,
      ExcusedColumn
    > extends never
      ? true
      : never;
    true satisfies UnbackedProjectionKeys<
      OutboundActionRow,
      StoredProjection,
      ExcusedColumn
    > extends never
      ? true
      : never;
    return Result.ok(payload);
  },
);

export default readOutboundAction;
