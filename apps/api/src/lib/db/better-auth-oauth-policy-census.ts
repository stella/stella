import { Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { isRecord } from "@/api/lib/type-guards";

type BetterAuthOAuthResourcePolicy = {
  allowedScopes: readonly string[];
  identifier: string;
  name: string;
};

export type BetterAuthOAuthPolicyDatabase = {
  execute: (statement: SQL) => Promise<unknown>;
};

export type BetterAuthOAuthPolicyTransactionalDatabase =
  BetterAuthOAuthPolicyDatabase & {
    transaction: <T>(
      callback: (transaction: BetterAuthOAuthPolicyDatabase) => Promise<T>,
    ) => Promise<T>;
  };

const BETTER_AUTH_OAUTH_POLICY_CHECKS = {
  CLIENTS_LINKED: "clients-linked",
  LINKS_USE_CONFIGURED_RESOURCES: "links-use-configured-resources",
  RESOURCES_MATCH: "resources-match",
} as const;

type BetterAuthOAuthPolicyCheck =
  (typeof BETTER_AUTH_OAUTH_POLICY_CHECKS)[keyof typeof BETTER_AUTH_OAUTH_POLICY_CHECKS];

type BetterAuthOAuthPolicyCensusRow = {
  clientsLinked: boolean;
  linksUseConfiguredResources: boolean;
  resourcesMatch: boolean;
};

export class BetterAuthOAuthPolicyCensusError extends TaggedError(
  "BetterAuthOAuthPolicyCensusError",
)<{
  failedChecks: readonly BetterAuthOAuthPolicyCheck[];
  message: string;
}> {}

const rowsFromQueryResult = (result: unknown): readonly unknown[] | null => {
  if (Array.isArray(result)) {
    return Array.from(result, (entry: unknown) => entry);
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return Array.from(result["rows"], (entry: unknown) => entry);
  }
  return null;
};

const parseCensusRow = (
  value: unknown,
): BetterAuthOAuthPolicyCensusRow | null => {
  if (
    !isRecord(value) ||
    typeof value["clientsLinked"] !== "boolean" ||
    typeof value["linksUseConfiguredResources"] !== "boolean" ||
    typeof value["resourcesMatch"] !== "boolean"
  ) {
    return null;
  }
  return {
    clientsLinked: value["clientsLinked"],
    linksUseConfiguredResources: value["linksUseConfiguredResources"],
    resourcesMatch: value["resourcesMatch"],
  };
};

const requiredBooleanRow = (value: unknown, key: string): boolean | null =>
  isRecord(value) && typeof value[key] === "boolean" ? value[key] : null;

const failedCensusChecks = ({
  clientsLinked,
  linksUseConfiguredResources,
  resourcesMatch,
}: BetterAuthOAuthPolicyCensusRow): BetterAuthOAuthPolicyCheck[] => {
  const failed: BetterAuthOAuthPolicyCheck[] = [];
  if (!resourcesMatch) {
    failed.push(BETTER_AUTH_OAUTH_POLICY_CHECKS.RESOURCES_MATCH);
  }
  if (!clientsLinked) {
    failed.push(BETTER_AUTH_OAUTH_POLICY_CHECKS.CLIENTS_LINKED);
  }
  if (!linksUseConfiguredResources) {
    failed.push(BETTER_AUTH_OAUTH_POLICY_CHECKS.LINKS_USE_CONFIGURED_RESOURCES);
  }
  return failed;
};

/**
 * Fail closed before readiness when the migration-owned OAuth policy is not
 * usable by Better Auth 1.7. The query returns only booleans: startup logs
 * never expose client identifiers, resource rows, or counts.
 */
export const assertBetterAuthOAuthPolicyCensus = async (
  database: BetterAuthOAuthPolicyDatabase,
  expectedResources: readonly BetterAuthOAuthResourcePolicy[],
): Promise<void> => {
  const serializedResources = JSON.stringify(expectedResources);
  const result = await database.execute(sql`
    WITH expected_resource AS (
      SELECT expected.identifier,
             expected.name,
             ARRAY(
               SELECT jsonb_array_elements_text(expected."allowedScopes")
               ORDER BY 1
             ) AS allowed_scopes
        FROM jsonb_to_recordset(${serializedResources}::text::jsonb)
          AS expected(
            identifier text,
            name text,
            "allowedScopes" jsonb
          )
    )
    SELECT NOT EXISTS (
             SELECT 1
               FROM expected_resource expected
               FULL OUTER JOIN oauth_resource actual
                 ON actual.identifier = expected.identifier
              WHERE expected.identifier IS NULL
                 OR actual.identifier IS NULL
                 OR actual.name IS DISTINCT FROM expected.name
                 OR ARRAY(
                      SELECT unnest(actual.allowed_scopes)
                      ORDER BY 1
                    ) IS DISTINCT FROM expected.allowed_scopes
                 OR actual.disabled IS DISTINCT FROM false
           ) AS "resourcesMatch",
           NOT EXISTS (
             SELECT 1
               FROM oauth_client client
              WHERE NOT EXISTS (
                SELECT 1
                  FROM oauth_client_resource link
                 WHERE link.client_id = client.client_id
              )
           ) AS "clientsLinked",
           NOT EXISTS (
             SELECT 1
               FROM oauth_client_resource link
               LEFT JOIN expected_resource expected
                 ON expected.identifier = link.resource_id
              WHERE expected.identifier IS NULL
           ) AS "linksUseConfiguredResources"
  `);
  const row = parseCensusRow(rowsFromQueryResult(result)?.at(0));
  if (row === null) {
    throw new BetterAuthOAuthPolicyCensusError({
      failedChecks: [],
      message: "Better Auth OAuth policy census returned an invalid result",
    });
  }
  const failedChecks = failedCensusChecks(row);
  if (failedChecks.length === 0) {
    return;
  }
  throw new BetterAuthOAuthPolicyCensusError({
    failedChecks,
    message: "Better Auth OAuth policy migration is incomplete",
  });
};

const initializePristineBetterAuthOAuthPolicy = async (
  database: BetterAuthOAuthPolicyDatabase,
  expectedResources: readonly BetterAuthOAuthResourcePolicy[],
): Promise<void> => {
  await database.execute(sql`
    LOCK TABLE "user",
               account,
               oauth_client,
               oauth_client_resource,
               oauth_resource
      IN SHARE ROW EXCLUSIVE MODE
  `);
  const stateResult = await database.execute(sql`
    SELECT NOT EXISTS (SELECT 1 FROM "user")
       AND NOT EXISTS (SELECT 1 FROM account)
       AND NOT EXISTS (SELECT 1 FROM oauth_client)
       AND NOT EXISTS (SELECT 1 FROM oauth_client_resource)
       AND NOT EXISTS (SELECT 1 FROM oauth_resource)
      AS "isPristine"
  `);
  const isPristine = requiredBooleanRow(
    rowsFromQueryResult(stateResult)?.at(0),
    "isPristine",
  );
  if (isPristine === null) {
    throw new BetterAuthOAuthPolicyCensusError({
      failedChecks: [],
      message: "Better Auth OAuth policy census returned an invalid result",
    });
  }
  if (!isPristine) {
    return;
  }

  const resourcesWithIds = expectedResources.map((resource) => ({
    ...resource,
    id: Bun.randomUUIDv7(),
  }));
  const serializedResources = JSON.stringify(resourcesWithIds);
  await database.execute(sql`
    INSERT INTO oauth_resource (id, identifier, name, allowed_scopes)
    SELECT resource.id,
           resource.identifier,
           resource.name,
           ARRAY(
             SELECT jsonb_array_elements_text(resource."allowedScopes")
             ORDER BY 1
           )
      FROM jsonb_to_recordset(${serializedResources}::text::jsonb)
        AS resource(
          id text,
          identifier text,
          name text,
          "allowedScopes" jsonb
        )
  `);
};

/**
 * New installations have no pre-migration baseline from which to run the
 * deployment backfill. Initialize only an entirely empty auth database, under
 * locks that make the decision atomic. Existing or partial databases remain
 * read-only and fail the same census instead of being repaired at startup.
 */
export const ensureBetterAuthOAuthPolicy = async (
  database: BetterAuthOAuthPolicyTransactionalDatabase,
  expectedResources: readonly BetterAuthOAuthResourcePolicy[],
): Promise<void> => {
  const initialCensus = await Result.tryPromise({
    try: async () =>
      await assertBetterAuthOAuthPolicyCensus(database, expectedResources),
    catch: (cause) => cause,
  });
  if (Result.isOk(initialCensus)) {
    return;
  }
  if (!(initialCensus.error instanceof BetterAuthOAuthPolicyCensusError)) {
    throw initialCensus.error;
  }

  await database.transaction(async (transaction) => {
    await initializePristineBetterAuthOAuthPolicy(
      transaction,
      expectedResources,
    );
    await assertBetterAuthOAuthPolicyCensus(transaction, expectedResources);
  });
};
