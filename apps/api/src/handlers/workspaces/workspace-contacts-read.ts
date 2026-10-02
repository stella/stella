import { Result } from "better-result";

import { MATTER_CONTACT_CAPACITY_CODE } from "@stll/api-contract/workspace-contacts";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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
  if (result.isErr()) {
    return result;
  }
  if (result.value.length > LIMITS.workspaceContactsCount) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: MATTER_CONTACT_CAPACITY_CODE.exceeded,
        retryable: false,
        message:
          "This matter has more contacts than can be displayed. Remove contact links before opening the list.",
        hint: "Call link_matter_contact with matter_id and a known matter_contact_id (without role) to remove a link, then read the list again.",
      }),
    );
  }
  return Result.ok(result.value);
};
