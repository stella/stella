import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  desktopTimeEntryBatchStatusRequestSchema,
  desktopTimeEntryBatchStatusSchema,
} from "@stll/api-contract/desktop-time-entries";

import { abortableTx } from "@/api/db/safe-db";
import { desktopTimeEntryBatches } from "@/api/db/schema";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

import { authorizeDesktopTimeEntries } from "./authorize";

export const createDesktopTimeEntryBatchStatusEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      body: desktopTimeEntryBatchStatusRequestSchema,
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopTimeEntryBatchStatusSchema,
      ),
    },
    async function* ({ request, body: { idempotencyKey } }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      return yield* Result.await(
        abortableTx(account.safeDb, async (tx) => {
          await withAggregateLock({
            aggregate: "desktopBatch",
            tx,
            id: {
              organizationId: account.organizationId,
              userId: account.userId,
              idempotencyKey,
            },
          });
          const [receipt] = await tx
            .select()
            .from(desktopTimeEntryBatches)
            .where(
              and(
                eq(
                  desktopTimeEntryBatches.organizationId,
                  account.organizationId,
                ),
                eq(desktopTimeEntryBatches.userId, account.userId),
                eq(desktopTimeEntryBatches.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (receipt?.status === "cancelled") {
            return { type: "cancelled" } as const;
          }
          if (receipt) {
            if (!receipt.result) {
              panic("Committed batch receipt has no result");
            }
            return { type: "committed", ...receipt.result } as const;
          }
          // Absence alone cannot rule out a delayed original request. The same
          // lock and a durable cancellation receipt fence it before local release.
          const result = { type: "cancelled" } as const;
          // audit: skip - Idempotency cancellation bookkeeping creates no time entries.
          await tx.insert(desktopTimeEntryBatches).values({
            organizationId: account.organizationId,
            userId: account.userId,
            idempotencyKey,
            requestFingerprint: null,
            status: result.type,
            result: null,
          });
          return result;
        }),
      );
    },
  );

export default createDesktopTimeEntryBatchStatusEndpoint();
