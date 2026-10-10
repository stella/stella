import { panic } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { PROVISION_LINK_CAPABILITIES } from "@stll/api-contract/provision-link-capability";
import type { ProvisionPendingCount } from "@stll/api-contract/provision-link-capability";

import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-content-hash";

const pendingRowSchema = v.strictObject({
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

/** Call in the coverage reader's repeatable-read snapshot. */
export const readProvisionPendingCounts = async (
  tx: CaseLawPublicReadTransaction,
) => {
  const entries: {
    country: (typeof CASE_LAW_JURISDICTIONS)[number];
    state: ProvisionPendingCount;
  }[] = [];
  for (const country of CASE_LAW_JURISDICTIONS) {
    const capability = PROVISION_LINK_CAPABILITIES[country];
    if (capability.type === "notSupportedYet") {
      entries.push({ country, state: capability });
      continue;
    }
    const language =
      capability.languages.at(0) ??
      panic("Supported capability has no language");
    const result = await tx
      .select({
        availability: sql<string>`availability`,
        pending_count: sql<string | null>`pending_count`,
        oldest_pending_at: sql<string | null>`oldest_pending_at::text`,
        sampled_at: sql<string>`sampled_at::text`,
        revision: sql<number | null>`revision`,
        scope_generation: sql<string | null>`scope_generation::text`,
      })
      .from(
        sql`read_case_law_provision_pending(${country}, ${language}, ARRAY[${sql.join(
          EMPTY_CORPUS_CONTENT_HASHES.map((hash) => sql`${hash}`),
          sql`, `,
        )}]::text[]) AS pending`,
      );
    const row = v.parse(pendingRowSchema, result.at(0));
    if (row.availability !== "available") {
      entries.push({
        country,
        state: {
          type: "unavailable",
          reason: row.availability,
          lastSampledAt: null,
        },
      });
      continue;
    }
    if (
      row.pending_count === null ||
      row.revision === null ||
      row.scope_generation === null
    ) {
      panic("Available provision count has incomplete metadata");
    }
    entries.push({
      country,
      state: {
        type: "available",
        pendingCount: row.pending_count,
        oldestPendingAt: row.oldest_pending_at,
        sampledAt: row.sampled_at,
        revision: row.revision,
        scopeGeneration: row.scope_generation,
      },
    });
  }
  return entries;
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
