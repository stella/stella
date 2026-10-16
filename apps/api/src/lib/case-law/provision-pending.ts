import { panic } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { PROVISION_LINK_CAPABILITIES } from "@stll/api-contract/provision-link-capability";
import type { ProvisionPendingCount } from "@stll/api-contract/provision-link-capability";

import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-content-hash";

const pendingRowSchema = v.strictObject({
  country: v.picklist(CASE_LAW_JURISDICTIONS),
  availability: v.picklist([
    "available",
    "scope_inactive",
    "revision_unavailable",
    "state_not_seeded",
  ]),
  pending_count: v.nullable(v.string()),
  oldest_pending_at: v.nullable(v.string()),
  sampled_at: v.string(),
  revision: v.nullable(v.number()),
  scope_generation: v.nullable(
    v.pipe(v.string(), v.transform(Number), v.safeInteger()),
  ),
});

type ProvisionPendingCounts = {
  country: CaseLawJurisdiction;
  state: ProvisionPendingCount;
}[];

/** Call in the coverage reader's repeatable-read snapshot. */
export const readProvisionPendingCounts = async (
  tx: CaseLawPublicReadTransaction,
): Promise<ProvisionPendingCounts> => {
  const supportedScopes = CASE_LAW_JURISDICTIONS.flatMap((country) => {
    const capability = PROVISION_LINK_CAPABILITIES[country];
    if (capability.type === "notSupportedYet") {
      return [];
    }
    const language =
      capability.languages.at(0) ??
      panic("Supported capability has no language");
    return [sql`(${country}::text, ${language}::text)`];
  });
  const result =
    supportedScopes.length === 0
      ? []
      : await tx.select({
          country: sql<string>`scope.country`,
          availability: sql<string>`pending.availability`,
          pending_count: sql<string | null>`pending.pending_count`,
          oldest_pending_at: sql<
            string | null
          >`pending.oldest_pending_at::text`,
          sampled_at: sql<string>`pending.sampled_at::text`,
          revision: sql<number | null>`pending.revision`,
          scope_generation: sql<string | null>`pending.scope_generation::text`,
        })
          .from(sql`(VALUES ${sql.join(supportedScopes, sql`, `)}) AS scope(country, language)
        CROSS JOIN LATERAL read_case_law_provision_pending(
          scope.country, scope.language, ARRAY[${sql.join(
            EMPTY_CORPUS_CONTENT_HASHES.map((hash) => sql`${hash}`),
            sql`, `,
          )}]::text[]
        ) AS pending`);
  const rows = new Map(
    v.parse(v.array(pendingRowSchema), result).map((row) => [row.country, row]),
  );
  return CASE_LAW_JURISDICTIONS.map((country) => {
    const capability = PROVISION_LINK_CAPABILITIES[country];
    if (capability.type === "notSupportedYet") {
      return { country, state: capability };
    }
    const row =
      rows.get(country) ?? panic("Supported provision scope has no count");
    if (row.availability !== "available") {
      return {
        country,
        state: {
          type: "unavailable",
          reason: row.availability,
          lastSampledAt: null,
        } satisfies ProvisionPendingCount,
      };
    }
    if (
      row.pending_count === null ||
      row.revision === null ||
      row.scope_generation === null
    ) {
      panic("Available provision count has incomplete metadata");
    }
    return {
      country,
      state: {
        type: "available",
        pendingCount: row.pending_count,
        oldestPendingAt: row.oldest_pending_at,
        sampledAt: row.sampled_at,
        revision: row.revision,
        scopeGeneration: row.scope_generation,
      } satisfies ProvisionPendingCount,
    };
  });
};

export const unavailableProvisionPendingCounts = () =>
  CASE_LAW_JURISDICTIONS.map((country) => {
    const capability = PROVISION_LINK_CAPABILITIES[country];
    const state: ProvisionPendingCount =
      capability.type === "notSupportedYet"
        ? capability
        : { type: "unavailable", reason: "read_failed", lastSampledAt: null };
    return { country, state };
  });
