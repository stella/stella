/**
 * An AVT view verifies a matter's documents against one of its legal lists,
 * so storing one needs the lists feature, and a picked list must belong to
 * the matter the view is in. Checked inside the transaction that writes the
 * view; the list row is share-locked so it cannot be deleted before commit.
 */

import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { legalLists } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ViewLayout } from "@/api/lib/views-schema";

export type AvtLayoutRejection = "legal-lists-disabled" | "list-not-found";

type RejectAvtLayoutArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  layout: ViewLayout;
  legalListsEnabled: boolean;
};

/** Null when the layout may be stored; otherwise why not. */
export const rejectAvtLayout = async ({
  tx,
  workspaceId,
  layout,
  legalListsEnabled,
}: RejectAvtLayoutArgs): Promise<AvtLayoutRejection | null> => {
  if (layout.type !== "avt") {
    return null;
  }
  if (!legalListsEnabled) {
    return "legal-lists-disabled";
  }
  if (layout.listId === null) {
    return null;
  }
  const list = await tx
    .select({ id: legalLists.id })
    .from(legalLists)
    .where(
      and(
        eq(legalLists.id, layout.listId),
        eq(legalLists.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .for("share");
  return list.length === 0 ? "list-not-found" : null;
};

const REJECTION_ERRORS = {
  "legal-lists-disabled": {
    status: 422,
    message: "AVT views need legal lists, which this deployment does not serve.",
  },
  "list-not-found": {
    status: 404,
    message: "The AVT view's list is not a list of this matter.",
  },
} as const satisfies Record<
  AvtLayoutRejection,
  { status: number; message: string }
>;

export const avtLayoutError = (rejection: AvtLayoutRejection): HandlerError =>
  new HandlerError(REJECTION_ERRORS[rejection]);
