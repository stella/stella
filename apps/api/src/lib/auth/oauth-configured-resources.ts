import type {
  DBAdapter,
  DBTransactionAdapter,
} from "@better-auth/core/db/adapter";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { isRecord } from "@/api/lib/type-guards";

/** The provider's model name for `oauth_resource` rows. */
const OAUTH_RESOURCE_MODEL = "oauthResource";

type ConfiguredOAuthResource = {
  readonly allowedScopes: readonly string[];
  readonly identifier: string;
};

/**
 * One stored resource row as this code may use it: `null` when this code does
 * not configure the resource, otherwise the row with its allowed scopes cut
 * down to the configured ones. A row stored without a scope restriction
 * (`null`, which the provider reads as "any scope") gets exactly the
 * configured set. A row whose identifier cannot be read is dropped.
 */
const narrowStoredResource = <T>(
  configured: ReadonlyMap<string, ReadonlySet<string>>,
  row: T,
): T | null => {
  if (!isRecord(row) || typeof row["identifier"] !== "string") {
    return null;
  }
  const allowed = configured.get(row["identifier"]);
  if (allowed === undefined) {
    return null;
  }
  if (!("allowedScopes" in row)) {
    return row;
  }
  const stored = row["allowedScopes"];
  return {
    ...row,
    allowedScopes: Array.isArray(stored)
      ? stored.filter(
          (scope): scope is string =>
            typeof scope === "string" && allowed.has(scope),
        )
      : [...allowed],
  };
};

/**
 * The provider reads `oauth_resource` on every authorization, token and
 * refresh request and intersects the grant with the row's `allowed_scopes`.
 * That table is shared by every release that touches the database: a newer
 * release's deploy adds the scopes and resources it defines, and the previous
 * release keeps serving beside them during a rollout and after a rollback.
 *
 * So the provider never sees the stored rows directly. Every read of the
 * resource model passes through this policy: a resource this code does not
 * configure reads as absent (`invalid_target`, no token for an audience this
 * code does not serve), and a configured one carries only the scopes this
 * code configures for it (a scope a newer release added is dropped from the
 * grant, not issued). The stored policy may therefore grow ahead of the code,
 * which is what lets the boot census accept a superset, while what this code
 * grants stays exactly what it defines.
 */
export const withConfiguredOAuthResources = (
  adapter: DBAdapter,
  resources: readonly ConfiguredOAuthResource[],
): DBAdapter => {
  const configured = new Map(
    resources.map(({ identifier, allowedScopes }) => [
      identifier,
      new Set(allowedScopes),
    ]),
  );
  const narrow = (raw: DBTransactionAdapter): DBTransactionAdapter => ({
    ...raw,
    findOne: async <T>(args: Parameters<typeof raw.findOne>[0]) => {
      const row = await raw.findOne<T>(args);
      return row === null || args.model !== OAUTH_RESOURCE_MODEL
        ? row
        : narrowStoredResource(configured, row);
    },
    findMany: async <T>(args: Parameters<typeof raw.findMany>[0]) => {
      const rows = await raw.findMany<T>(args);
      return args.model === OAUTH_RESOURCE_MODEL
        ? rows.flatMap((row) => {
            const narrowed = narrowStoredResource(configured, row);
            return narrowed === null ? [] : [narrowed];
          })
        : rows;
    },
  });
  return {
    ...adapter,
    ...narrow(adapter),
    transaction: async (callback) =>
      await withAggregateTransaction(
        adapter,
        async (tx) => await callback(narrow(tx)),
      ),
  };
};
