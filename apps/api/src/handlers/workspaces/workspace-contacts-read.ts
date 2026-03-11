import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspaceContactsHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readWorkspaceContactsHandler = ({
  scopedDb,
  workspaceId,
}: ReadWorkspaceContactsHandlerProps) =>
  scopedDb((tx) =>
    tx.query.workspaceContacts.findMany({
      where: { workspaceId: { eq: workspaceId } },
      limit: LIMITS.workspaceContactsCount,
      with: {
        contact: {
          columns: {
            id: true,
            type: true,
            displayName: true,
            color: true,
          },
        },
      },
    }),
  );
