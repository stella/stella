import { Result } from "better-result";
import { t } from "elysia";

import {
  CONTACT_CURSOR_MAX_LENGTH,
  listContactsPage,
} from "@/api/handlers/contacts/list-query";
import { contactTypeSchema } from "@/api/handlers/contacts/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const readContactsQuerySchema = t.Object({
  limit: t.Optional(tPaginationLimit(LIMITS.contactsPageSizeMax)),
  cursor: t.Optional(
    tPaginationCursor({ maxChars: CONTACT_CURSOR_MAX_LENGTH }),
  ),
  type: t.Optional(contactTypeSchema),
  q: t.Optional(t.String()),
});

const readContacts = createSafeRootHandler(
  {
    description:
      "List the organization address book alphabetically by display name, " +
      "with cursor pagination. Filter by type (person or organization) and " +
      "by q, which matches a substring of the display name only. Each item " +
      "carries the names, emails, phones, tags, and the number of matters " +
      "the contact is the client of. Use contacts.search for a short " +
      "unpaginated lookup that also matches first, last, and organization " +
      "names.",
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
