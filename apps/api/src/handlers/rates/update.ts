import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";
import { t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tDefaultVarchar, tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const updateRateTableBodySchema = t.Object({
  id: tUuid,
  name: t.Optional(tDefaultVarchar),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  isDefault: t.Optional(t.Boolean()),
});

const updateRateTable = createSafeHandler(
  {
    permissions: { rate: ["update"] },
    body: updateRateTableBodySchema,
  },
  async function* ({ safeDb, workspaceId, body }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: { id: body.id, workspaceId: { eq: workspaceId } },
          columns: { id: true },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }

    const updates = {
      ...pickDefined(body, ["name", "currency", "isDefault"]),
      updatedAt: new Date(),
    };

    // Prevent unsetting isDefault if no other default exists
    if (body.isDefault === false) {
      const otherDefaultRows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ id: rateTables.id })
            .from(rateTables)
            .where(
              and(
                eq(rateTables.workspaceId, workspaceId),
                eq(rateTables.isDefault, true),
                ne(rateTables.id, body.id),
              ),
            )
            .limit(1),
        ),
      );
      const otherDefault = otherDefaultRows.at(0);

      if (!otherDefault) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Cannot unset default: no other default rate table exists",
          }),
        );
      }
    }

    yield* Result.await(
      safeDb(async (tx) => {
        if (body.isDefault) {
          await tx
            .update(rateTables)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(rateTables.workspaceId, workspaceId),
                eq(rateTables.isDefault, true),
              ),
            );
        }

        await tx
          .update(rateTables)
          .set(updates)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
            ),
          );
      }),
    );

    return Result.ok({ id: body.id });
  },
);

export default updateRateTable;
