import { and, eq, ilike, or } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { contacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";

const SEARCH_LIMIT = 20;

type SearchContactsHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  q: string;
  type?: "person" | "organization" | undefined;
};

export const searchContactsHandler = async ({
  scopedDb,
  organizationId,
  q,
  type,
}: SearchContactsHandlerProps) => {
  const pattern = `%${escapeLike(q)}%`;

  const conditions = [
    eq(contacts.organizationId, organizationId),
    or(
      ilike(contacts.displayName, pattern),
      ilike(contacts.firstName, pattern),
      ilike(contacts.lastName, pattern),
      ilike(contacts.organizationName, pattern),
    ),
  ];

  if (type) {
    conditions.push(eq(contacts.type, type));
  }

  const items = await scopedDb((tx) =>
    tx
      .select({
        id: contacts.id,
        type: contacts.type,
        displayName: contacts.displayName,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        organizationName: contacts.organizationName,
        emails: contacts.emails,
        color: contacts.color,
      })
      .from(contacts)
      .where(and(...conditions))
      .orderBy(contacts.displayName)
      .limit(SEARCH_LIMIT),
  );

  return { items };
};
