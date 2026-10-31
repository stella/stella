import type {
  DBAdapter,
  DBTransactionAdapter,
} from "@better-auth/core/db/adapter";
import { panic } from "better-result";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

const MEMBER_MODEL = "member";
const ORGANIZATION_MODEL = "organization";

const batchOrganizationMemberships = (
  adapter: DBTransactionAdapter,
): DBTransactionAdapter => ({
  ...adapter,
  // Better Auth's fallback join reads each organization separately. Keep
  // batching inside the bound adapter so its transforms and transaction apply.
  findMany: async <T>(args: Parameters<typeof adapter.findMany>[0]) => {
    if (args.model !== MEMBER_MODEL || !args.join?.[ORGANIZATION_MODEL]) {
      return await adapter.findMany<T>({
        model: args.model,
        where: args.where,
        limit: args.limit,
        select: args.select,
        sortBy: args.sortBy,
        offset: args.offset,
        join: args.join,
      });
    }
    const remainingJoins = Object.fromEntries(
      Object.entries(args.join).filter(
        ([model]) => model !== ORGANIZATION_MODEL,
      ),
    );
    const rows = await adapter.findMany<T>({
      model: args.model,
      where: args.where,
      limit: args.limit,
      select: args.select,
      sortBy: args.sortBy,
      offset: args.offset,
      join:
        Object.keys(remainingJoins).length === 0 ? undefined : remainingJoins,
    });
    if (rows.length === 0) {
      return rows;
    }
    const memberships = rows.map((row) => {
      if (!isRecord(row) || typeof row["organizationId"] !== "string") {
        return panic("Organization joins require membership organization IDs");
      }
      return {
        row,
        organizationId: brandPersistedOrganizationId(row["organizationId"]),
      };
    });
    const organizationIds = [
      ...new Set(memberships.map((membership) => membership.organizationId)),
    ];
    const organizations = await adapter.findMany<Record<string, unknown>>({
      model: ORGANIZATION_MODEL,
      where: [{ field: "id", operator: "in", value: organizationIds }],
      limit: organizationIds.length,
    });
    const byId = new Map(
      organizations.map((org) => {
        const id = org["id"];
        if (typeof id !== "string") {
          return panic("Organization adapter output requires an ID");
        }
        return [id, org] as const;
      }),
    );
    return memberships.map((membership) => ({
      ...membership.row,
      organization:
        byId.get(membership.organizationId) ??
        panic("Membership organization is missing"),
    }));
  },
});

export const withBatchedOrganizationMemberships = (
  adapter: DBAdapter,
): DBAdapter => ({
  ...batchOrganizationMemberships(adapter),
  transaction: async (callback) =>
    await withAggregateTransaction(
      adapter,
      async (tx) => await callback(batchOrganizationMemberships(tx)),
    ),
});
