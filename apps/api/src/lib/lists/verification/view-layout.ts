import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { legalLists } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { ViewLayout } from "@/api/lib/views-schema";

export type AvtLayoutRejection = "access-unavailable" | "list-not-found";

type RejectAvtLayoutArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  layout: ViewLayout;
  legalListsEnabled: boolean;
  accessStatus: "available" | "unavailable";
};

/** Null when the layout may be stored; otherwise why not. */
export const rejectAvtLayout = async ({
  tx,
  workspaceId,
  layout,
  legalListsEnabled,
  accessStatus,
}: RejectAvtLayoutArgs): Promise<AvtLayoutRejection | null> => {
  if (layout.type !== "avt") {
    return null;
  }
  if (!legalListsEnabled || accessStatus !== "available") {
    return "access-unavailable";
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
  "access-unavailable": {
    status: 404,
    message: "Not found",
  },
  "list-not-found": {
    status: 404,
    message: "The AVT view's list is not a list of this matter.",
  },
} as const satisfies Record<
  AvtLayoutRejection,
  { status: number; message: string }
>;

/** The status and message a handler aborts with for a rejection. */
export const avtLayoutErrorDetail = (rejection: AvtLayoutRejection) =>
  REJECTION_ERRORS[rejection];
