import { Result } from "better-result";
import { t } from "elysia";

import { listContactsPage } from "@/api/handlers/contacts/list-query";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationLimit } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const readContactsQuerySchema = t.Object({
  limit: t.Optional(tPaginationLimit(LIMITS.contactsPageSizeMax)),
  cursor: t.Optional(t.String()),
  type: t.Optional(t.Union([t.Literal("person"), t.Literal("organization")])),
  q: t.Optional(t.String()),
});

const readContacts = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "tool", name: "list_contacts" },
    access: "read",
    query: readContactsQuerySchema,
  },
  async function* ({ safeDb, session, query }) {
    const page = yield* Result.await(
      listContactsPage({
        safeDb,
        organizationId: session.activeOrganizationId,
        query,
      }),
    );
    return Result.ok(page);
  },
);

export default readContacts;
