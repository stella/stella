import { asc, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawProvisionCitations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  PROVISION_LINK_READ_MAX_ROWS,
  provisionKeysOfLinks,
} from "@/api/lib/case-law/provision-keys";
import { caseLawJurisdictionHasProvisionKeys } from "@/api/lib/legal-search/case-law-index-groups";
import { logger } from "@/api/lib/observability/logger";

type ProvisionKeyDecision = {
  id: SafeId<"caseLawDecision">;
  jurisdiction: string;
};

/**
 * The provision keys of one decision: a probe by `decision_id`, which leads the
 * links' unique `(decision_id, span_start, anchor)` index, in that index's own
 * order and bounded by `PROVISION_LINK_READ_MAX_ROWS`. One row past the bound
 * proves the decision has more, which is a typed, logged condition and never a
 * silent cut; so is a key set past its own bound.
 */
const readDecisionProvisionKeys = async (
  tx: Transaction,
  decisionId: SafeId<"caseLawDecision">,
): Promise<readonly string[]> => {
  const rows = await tx
    .select({
      workIdentifier: caseLawProvisionCitations.workIdentifier,
      anchor: caseLawProvisionCitations.anchor,
    })
    .from(caseLawProvisionCitations)
    .where(eq(caseLawProvisionCitations.decisionId, decisionId))
    .orderBy(
      asc(caseLawProvisionCitations.spanStart),
      asc(caseLawProvisionCitations.anchor),
    )
    .limit(PROVISION_LINK_READ_MAX_ROWS + 1);
  const rowsCapped = rows.length > PROVISION_LINK_READ_MAX_ROWS;
  const { keys, dropped } = provisionKeysOfLinks(
    rowsCapped ? rows.slice(0, PROVISION_LINK_READ_MAX_ROWS) : rows,
  );
  if (rowsCapped || dropped > 0) {
    logger.warn("case_law.provision_keys.capped", {
      decisionId,
      rowsCapped,
      droppedKeys: dropped,
      keptKeys: keys.length,
    });
  }
  return keys;
};

/**
 * The one loader of the provision keys a case-law projection input carries.
 * The canonical lock read, the batched material read and the bootstrap walk
 * all call it, so the three derive the same keys from the same links.
 *
 * A decision of a group whose contract has no `provision_keys` field is not
 * read at all and maps to no keys: its fingerprint and its documents do not
 * change, and a jurisdiction without the field pays no query.
 */
export const readCaseLawProvisionKeys = async (
  tx: Transaction,
  decisions: readonly ProvisionKeyDecision[],
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const keyed = decisions.filter(({ jurisdiction }) =>
    caseLawJurisdictionHasProvisionKeys(jurisdiction),
  );
  const loaded = await Promise.all(
    keyed.map(async ({ id }): Promise<[string, readonly string[]]> => [
      String(id),
      await readDecisionProvisionKeys(tx, id),
    ]),
  );
  return new Map<string, readonly string[]>([
    ...decisions.map(({ id }): [string, readonly string[]] => [String(id), []]),
    ...loaded,
  ]);
};
