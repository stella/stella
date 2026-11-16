import { Result } from "better-result";

import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";

/** `GET /v1/workspaces/:workspaceId/contacts`: the matter's parties. */
const readWorkspaceContacts = createSafeHandler(
  {
    contract: "patch",
    description:
      "List a matter's linked contacts besides its client, oldest first: " +
      "each link's id, role and notes with the contact's id, type, display " +
      "name and colour. overflow is true when the matter holds more than " +
      "one answer carries. Link one with matters.contacts.create.",
    access: "read",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    workspaceStatus: "active-or-archived",
    mcp: { type: "covered", by: "list_matters" },
  } satisfies WorkspaceHandlerConfig,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      readWorkspaceContactsHandler({ workspaceId, scopedDb }),
    );

    return Result.ok(response);
  },
);

export default readWorkspaceContacts;
