import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type LoadRateEntryOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  rateTableId: SafeId<"rateTable">;
  entryId: SafeId<"rateEntry">;
};

/** Load one line of a rate table in the matter, 404 when either is missing. */
export const loadRateEntry = async ({
  safeDb,
  workspaceId,
  rateTableId,
  entryId,
}: LoadRateEntryOptions) =>
  await Result.gen(async function* () {
    const table = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: {
            id: { eq: rateTableId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!table) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateEntries.findFirst({
          where: {
            id: { eq: entryId },
            rateTableId: { eq: rateTableId },
          },
          columns: {
            id: true,
            userId: true,
            hourlyRate: true,
            effectiveFrom: true,
            effectiveTo: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate entry not found" }),
      );
    }

    return Result.ok(existing);
  });
