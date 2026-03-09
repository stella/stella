import { and, count, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { workspaceContacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadContactByIdHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  contactId: string;
};

export const readContactByIdHandler = async ({
  scopedDb,
  organizationId,
  contactId,
}: ReadContactByIdHandlerProps) => {
  const contact = await scopedDb((tx) =>
    tx.query.contacts.findFirst({
      where: {
        id: contactId,
        organizationId: { eq: organizationId },
      },
      with: {
        originatingAttorney: {
          columns: { id: true, name: true, image: true },
        },
        responsibleAttorney: {
          columns: { id: true, name: true, image: true },
        },
      },
    }),
  );

  if (!contact) {
    return status(404, { message: "Contact not found" });
  }

  const clientMatters = await scopedDb((tx) =>
    tx.query.workspaces.findMany({
      where: {
        clientId: contactId,
        organizationId: { eq: organizationId },
        status: "active",
      },
      columns: {
        id: true,
        name: true,
        color: true,
        createdAt: true,
      },
      limit: LIMITS.workspacesCount,
    }),
  );

  const [partyMatters] = await scopedDb((tx) =>
    tx
      .select({ count: count() })
      .from(workspaceContacts)
      .where(
        and(
          eq(workspaceContacts.contactId, contactId),
          eq(workspaceContacts.organizationId, organizationId),
        ),
      ),
  );

  return {
    ...contact,
    clientMatters,
    partyCount: partyMatters?.count ?? 0,
  };
};
