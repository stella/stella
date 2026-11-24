import { and, eq } from "drizzle-orm";

import { clauseVariants } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ClauseVariantReadLimitOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
};

export const clauseVariantReadLimit = async ({
  tx,
  organizationId,
  clauseId,
}: ClauseVariantReadLimitOptions) => {
  const savedCount = await tx.$count(
    clauseVariants,
    and(
      eq(clauseVariants.organizationId, organizationId),
      eq(clauseVariants.clauseId, clauseId),
    ),
  );
  // New writes cannot exceed the cap; legacy overflow cannot grow. Reserving
  // at least the cap also includes creates committed after this count.
  return Math.max(savedCount, LIMITS.clauseVariantsPerClause);
};
