import { Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspaceContactsHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readWorkspaceContactsHandler = async ({
  scopedDb,
  workspaceId,
}: ReadWorkspaceContactsHandlerProps) => {
  const result = await Result.tryPromise(
    async () =>
      await scopedDb((tx) =>
        tx.query.workspaceContacts.findMany({
          where: { workspaceId: { eq: workspaceId } },
          orderBy: { createdAt: "asc", id: "asc" },
          limit: LIMITS.workspaceContactsCount + 1,
          with: {
            contact: {
              columns: { id: true, type: true, displayName: true, color: true },
            },
          },
        }),
      ),
  );
  return result.map((contacts) => ({
    contacts: contacts.slice(0, LIMITS.workspaceContactsCount),
    overflow: contacts.length > LIMITS.workspaceContactsCount,
  }));
};
