import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";

type ResolveDocxEditAuthorNameOptions = {
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/** Resolve the authenticated actor's Word revision author; never fabricate it. */
export const resolveDocxEditAuthorName = async ({
  safeDb,
  userId,
}: ResolveDocxEditAuthorNameOptions): Promise<string | null> => {
  const result = await safeDb((tx) =>
    tx.query.user.findFirst({
      where: { id: { eq: userId } },
      columns: { name: true, preferredName: true },
    }),
  );
  if (Result.isError(result)) {
    return null;
  }

  const preferredName = result.value?.preferredName?.trim();
  if (preferredName) {
    return preferredName;
  }

  const name = result.value?.name.trim();
  return name || null;
};
