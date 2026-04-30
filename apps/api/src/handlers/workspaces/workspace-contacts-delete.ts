import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { workspaceContacts } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { upsertWorkspaceSearchDocument } from "@/api/lib/search/index-global";

const config = {
  permissions: { workspace: ["update"] },
  params: workspaceParams({ workspaceContactId: tSafeId("workspaceContact") }),
} satisfies HandlerConfig;

const deleteWorkspaceContact = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params: { workspaceContactId } }) {
    const deletedRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(workspaceContacts)
          .where(
            and(
              eq(workspaceContacts.id, workspaceContactId),
              eq(workspaceContacts.workspaceId, workspaceId),
            ),
          )
          .returning({ id: workspaceContacts.id }),
      ),
    );
    const deleted = deletedRows.at(0);

    if (!deleted) {
      return Result.err(
        new HandlerError({ status: 404, message: "Party not found" }),
      );
    }

    upsertWorkspaceSearchDocument(workspaceId).catch(captureError);

    return Result.ok({ id: deleted.id });
  },
);

export default deleteWorkspaceContact;
