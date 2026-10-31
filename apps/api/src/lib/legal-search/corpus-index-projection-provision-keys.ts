import { panic } from "better-result";
import { asc, inArray, lte, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawProvisionCitations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  PROVISION_LINK_READ_MAX_ROWS,
  provisionKeysOfLinks,
} from "@/api/lib/case-law/provision-keys";
import { readBounded } from "@/api/lib/db/read-bounded";
import { caseLawJurisdictionHasProvisionKeys } from "@/api/lib/legal-search/case-law-index-groups";
import { logger } from "@/api/lib/observability/logger";

type ProvisionKeyDecision = {
  id: SafeId<"caseLawDecision">;
  jurisdiction: string;
};

type ProvisionLinkRow = {
  decisionId: SafeId<"caseLawDecision">;
  workIdentifier: string;
  anchor: string;
};

/**
 * The provision links of these decisions in one statement, each decision cut
 * to `PROVISION_LINK_READ_MAX_ROWS + 1` rows by a window in text order, so the
 * whole read is bounded by the number of decisions however many links one of
 * them has. One row past a decision's bound proves it has more.
 */
const readProvisionLinkRows = async (
  tx: Transaction,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<ProvisionLinkRow[]> => {
  const link = caseLawProvisionCitations;
  const ranked = tx
    .select({
      decisionId: link.decisionId,
      workIdentifier: link.workIdentifier,
      anchor: link.anchor,
      spanStart: link.spanStart,
      rank: sql<number>`row_number() OVER (PARTITION BY ${link.decisionId} ORDER BY ${link.spanStart}, ${link.anchor})`.as(
        "rank",
      ),
    })
    .from(link)
    .where(inArray(link.decisionId, [...decisionIds]))
    .as("ranked_provision_links");
  const read = await readBounded(
    tx
      .select({
        decisionId: ranked.decisionId,
        workIdentifier: ranked.workIdentifier,
        anchor: ranked.anchor,
      })
      .from(ranked)
      .where(lte(ranked.rank, PROVISION_LINK_READ_MAX_ROWS + 1))
      .orderBy(
        asc(ranked.decisionId),
        asc(ranked.spanStart),
        asc(ranked.anchor),
      ),
    decisionIds.length * (PROVISION_LINK_READ_MAX_ROWS + 1),
  );
  if (read.type === "overflow") {
    // The window caps each decision, so the total cannot pass this bound.
    return panic("A windowed provision-link read exceeded its own bound", {
      cap: read.cap,
    });
  }
  return read.rows;
};

/**
 * The one loader of the provision keys a case-law projection input carries.
 * The canonical lock read, the batched material read and the bootstrap walk
 * all call it, so the three derive the same keys from the same links, and a
 * batch of decisions costs one statement, not one per decision.
 *
 * A decision of a group whose contract has no `provision_keys` field is not
 * read at all and maps to no keys: its fingerprint and its documents do not
 * change, and a jurisdiction without the field pays no query.
 *
 * A decision with more links than the bound keeps the keys of its first links
 * in text order; that, and a key set past its own bound, is a typed, logged
 * condition and never a silent cut.
 */
export const readCaseLawProvisionKeys = async (
  tx: Transaction,
  decisions: readonly ProvisionKeyDecision[],
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const keyed = decisions
    .filter(({ jurisdiction }) =>
      caseLawJurisdictionHasProvisionKeys(jurisdiction),
    )
    .map(({ id }) => id);
  // Every decision starts with no links, so a decision the read returns
  // nothing for maps to no keys without a lookup fallback.
  const byDecision = new Map(
    decisions.map(({ id }): [string, ProvisionLinkRow[]] => [String(id), []]),
  );
  if (keyed.length > 0) {
    for (const row of await readProvisionLinkRows(tx, keyed)) {
      const rows = byDecision.get(String(row.decisionId));
      if (rows === undefined) {
        // The read is filtered to the requested decisions.
        return panic("A provision-link read returned an unrequested decision", {
          decisionId: row.decisionId,
        });
      }
      rows.push(row);
    }
  }
  return new Map(
    [...byDecision].map(([id, rows]): [string, readonly string[]] => {
      const rowsCapped = rows.length > PROVISION_LINK_READ_MAX_ROWS;
      const { keys, dropped } = provisionKeysOfLinks(
        rowsCapped ? rows.slice(0, PROVISION_LINK_READ_MAX_ROWS) : rows,
      );
      if (rowsCapped || dropped > 0) {
        logger.warn("case_law.provision_keys.capped", {
          decisionId: id,
          rowsCapped,
          droppedKeys: dropped,
          keptKeys: keys.length,
        });
      }
      return [id, keys];
    }),
  );
};
