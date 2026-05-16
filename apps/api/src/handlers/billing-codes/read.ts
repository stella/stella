import { Result } from "better-result";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedBillingCodeId } from "@/api/lib/safe-id-boundaries";

const readBillingCodesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
  cursor: t.Optional(t.String({ maxLength: 512 })),
  type: t.Optional(t.Union([t.Literal("task"), t.Literal("activity")])),
  active: t.Optional(t.BooleanString()),
});

const config = {
  permissions: { workspace: ["read"] },
  query: readBillingCodesQuerySchema,
} satisfies HandlerConfig;

type BillingCodeCursor = {
  sortOrder: number;
  code: string;
  id: SafeId<"billingCode">;
};

const decodeBillingCodeCursor = (cursor: string): BillingCodeCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const sortOrder = parts?.at(0);
  const code = parts?.at(1);
  const id = parts?.at(2);

  if (
    typeof sortOrder !== "number" ||
    typeof code !== "string" ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }

  return { sortOrder, code, id: brandPersistedBillingCodeId(id) };
};

const readBillingCodes = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? 500;

    const conditions = [eq(billingCodes.workspaceId, workspaceId)];

    if (query.type) {
      conditions.push(eq(billingCodes.type, query.type));
    }
    if (query.active !== undefined) {
      conditions.push(eq(billingCodes.active, query.active));
    }
    if (query.cursor) {
      const cursor = decodeBillingCodeCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = or(
        gt(billingCodes.sortOrder, cursor.sortOrder),
        and(
          eq(billingCodes.sortOrder, cursor.sortOrder),
          gt(billingCodes.code, cursor.code),
        ),
        and(
          eq(billingCodes.sortOrder, cursor.sortOrder),
          eq(billingCodes.code, cursor.code),
          gt(billingCodes.id, cursor.id),
        ),
      );

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: billingCodes.id,
            type: billingCodes.type,
            code: billingCodes.code,
            label: billingCodes.label,
            active: billingCodes.active,
            sortOrder: billingCodes.sortOrder,
          })
          .from(billingCodes)
          .where(and(...conditions))
          .orderBy(
            asc(billingCodes.sortOrder),
            asc(billingCodes.code),
            asc(billingCodes.id),
          )
          .limit(limit + 1),
      ),
    );

    return Result.ok(
      createCursorPage({
        rows,
        limit,
        cursorForItem: (item) =>
          encodePaginationCursor([item.sortOrder, item.code, item.id]),
      }),
    );
  },
);

export default readBillingCodes;
