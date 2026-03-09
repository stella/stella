import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { caseLawMatterLinks } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DeleteMatterLinkProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  linkId: string;
};

export const deleteMatterLinkHandler = async ({
  scopedDb,
  workspaceId,
  linkId,
}: DeleteMatterLinkProps) => {
  const deleted = await scopedDb((tx) =>
    tx
      .delete(caseLawMatterLinks)
      .where(
        and(
          eq(caseLawMatterLinks.id, linkId),
          eq(caseLawMatterLinks.workspaceId, workspaceId),
        ),
      )
      .returning({ id: caseLawMatterLinks.id }),
  );

  if (deleted.length === 0) {
    return status(404, { message: "Matter link not found" });
  }

  return { success: true };
};
