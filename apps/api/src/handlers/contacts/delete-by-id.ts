import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { contacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DeleteContactByIdHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  contactId: string;
};

export const deleteContactByIdHandler = async ({
  scopedDb,
  organizationId,
  contactId,
}: DeleteContactByIdHandlerProps) => {
  const [deleted] = await scopedDb((tx) =>
    tx
      .delete(contacts)
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.organizationId, organizationId),
        ),
      )
      .returning({ id: contacts.id }),
  );

  if (!deleted) {
    return status(404, { message: "Contact not found" });
  }

  return;
};
