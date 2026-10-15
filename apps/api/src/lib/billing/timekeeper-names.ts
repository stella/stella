import { and, eq, inArray } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

/** The distinct users who logged `rows`, for one batched name lookup. */
export const timekeeperIdsOf = (rows: readonly { userId: string | null }[]) => {
  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.userId) {
      userIds.add(row.userId);
    }
  }
  return userIds;
};

type SelectTimekeeperNamesOptions = {
  organizationId: SafeId<"organization">;
  userIds: ReadonlySet<string>;
};

/** Names of the given users, restricted to members of the organization. */
export const selectTimekeeperNames = async (
  tx: Transaction,
  { organizationId, userIds }: SelectTimekeeperNamesOptions,
) =>
  await tx
    .select({ id: user.id, name: user.name })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.userId, [...userIds]),
      ),
    );
