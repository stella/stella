import { Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db-types";
import type { SafeId } from "@/api/lib/branded-types";

type ResolveDocxEditAuthorNameOptions = {
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/** Resolve the authenticated actor's Word revision author; never fabricate it. */
export const resolveDocxEditAuthorName = async ({
  safeDb,
  userId,
}: ResolveDocxEditAuthorNameOptions): Promise<
  Result<string | null, SafeDbError>
> => {
  const result = await safeDb((tx) =>
    tx.query.user.findFirst({
      where: { id: { eq: userId } },
      columns: { name: true, preferredName: true },
    }),
  );
  if (Result.isError(result)) {
    return result;
  }

  const preferredName = result.value?.preferredName?.trim();
  if (preferredName) {
    return Result.ok(preferredName);
  }

  const name = result.value?.name.trim();
  return Result.ok(name || null);
};
