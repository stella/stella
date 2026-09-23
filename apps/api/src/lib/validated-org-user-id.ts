import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";

/**
 * A user ID that has been validated as belonging to the given organization.
 * Prevents cross-org user ID injection at the type level: handlers that
 * accept a userId from user input must call `validateOrgUserId` first,
 * and the branded return type proves the check happened.
 *
 * The membership query is what establishes the guarantee; the predicate only
 * gates branding. It is parsed with `v.parse`, so it must accept every id the
 * `member.user_id` column can hold or a confirmed member throws instead of
 * branding; `parseAuthProviderId` is the parser that knows that shape.
 */
const validatedOrgUserIdSchema = v.pipe(
  v.custom<SafeId<"user">>(
    (value) =>
      typeof value === "string" && parseAuthProviderId<"user">(value) !== null,
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

/**
 * Verify every id in `userIds` is a member of `organizationId` in one read.
 * Returns the branded ids in input order, or `null` when any is not a member.
 */
export const validateOrgUserIds = async (
  tx: Transaction,
  userIds: readonly SafeId<"user">[],
  organizationId: SafeId<"organization">,
): Promise<ValidatedOrgUserId[] | null> => {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) {
    return [];
  }
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.userId, uniqueUserIds),
      ),
    );
  const memberIds = new Set(rows.map((row) => row.userId));
  if (uniqueUserIds.some((candidate) => !memberIds.has(candidate))) {
    return null;
  }
  return userIds.map((id) => v.parse(validatedOrgUserIdSchema, id));
};
