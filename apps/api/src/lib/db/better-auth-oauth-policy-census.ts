import { TaggedError } from "better-result";
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
