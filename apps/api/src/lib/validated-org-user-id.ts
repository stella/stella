import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * A user ID that has been validated as belonging to the given organization.
 * Prevents cross-org user ID injection at the type level: handlers that
 * accept a userId from user input must call `validateOrgUserId` first,
 * and the branded return type proves the check happened.
 */
const validatedOrgUserIdSchema = v.pipe(
  v.custom<SafeId<"user">>((value) =>
    typeof value === "string"
      ? v.is(v.pipe(v.string(), v.uuid()), value)
      : false,
  ),
  v.brand("ValidatedOrgUserId"),
);

export type ValidatedOrgUserId = v.InferOutput<typeof validatedOrgUserIdSchema>;

/**
 * Verify that `userId` is a member of `organizationId`.
 * Returns a branded `ValidatedOrgUserId` on success, or `null` if the
 * user is not a member of the organization.
 */
export const validateOrgUserId = async (
  tx: Transaction,
  userId: SafeId<"user">,
  organizationId: SafeId<"organization">,
): Promise<ValidatedOrgUserId | null> => {
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);

  const row = rows.at(0);
  if (!row) {
    return null;
  }

  return v.parse(validatedOrgUserIdSchema, row.userId);
};
