/**
 * Ask the resolver again about every `ambiguous` citation.
 *
 * A resolution rule added after the walk settled a row changes nothing for
 * that row on its own: settled rows leave the walk's predicate. This puts the
 * ambiguous ones back, one bounded keyset batch at a time, and resolves each
 * batch in the same transaction, so the standing walk never sees them pending.
 *
 * Idempotent and resumable: rows the rules still cannot decide come back
 * `ambiguous`, and a rerun walks the same range to the same answers. Pass a
 * cursor to resume after an interruption; every batch prints the one to use.
 *
 *   bun apps/api/src/scripts/readjudicate-ambiguous-citations.ts [--after <citingDecisionId>:<citationId>]
 */

import { panic } from "better-result";

import { rootDb } from "@/api/db/root";
import {
  type CitationResolutionCursor,
  readjudicateAmbiguousCitations,
} from "@/api/handlers/case-law/citation-resolution";
import { CITATION_RESOLUTION_RULE } from "@/api/handlers/case-law/citation-resolution-status";
import { isUuid } from "@/api/lib/custom-schema";

const BATCH = 2000;

const parseCursor = (
  argv: readonly string[],
): CitationResolutionCursor | null => {
  const index = argv.indexOf("--after");
  if (index === -1) {
    return null;
  }
  const value = argv.at(index + 1);
  if (value === undefined) {
    panic("--after expects <citingDecisionId>:<citationId>");
  }
  const separator = value.indexOf(":");
  if (separator === -1) {
    panic("--after expects <citingDecisionId>:<citationId>");
  }
  const citingDecisionId = value.slice(0, separator);
  const citationId = value.slice(separator + 1);
  if (!isUuid(citingDecisionId) || !isUuid(citationId)) {
    panic("--after expects two UUIDs: <citingDecisionId>:<citationId>");
  }
  return { citingDecisionId, citationId };
};

type Totals = {
  scanned: number;
  resolved: number;
  uniqueKey: number;
  ambiguous: number;
};

const describe = (totals: Totals): string =>
  `${totals.scanned} re-examined, ${totals.resolved} resolved (${totals.resolved - totals.uniqueKey} by adjudication), ${totals.ambiguous} still ambiguous`;

// One batch per step; the next step starts from the cursor this one returned.
const walk = async (
  after: CitationResolutionCursor | null,
  totals: Totals,
): Promise<Totals> => {
  const batch = await readjudicateAmbiguousCitations(
    async (fn) => await rootDb.transaction(fn),
    { limit: BATCH, after },
  );
  if (batch.scanned === 0 || batch.cursor === null) {
    return totals;
  }
  const next: Totals = {
    scanned: totals.scanned + batch.scanned,
    resolved: totals.resolved + batch.resolved,
    uniqueKey:
      totals.uniqueKey +
      batch.resolvedByRule[CITATION_RESOLUTION_RULE.UNIQUE_KEY],
    ambiguous: totals.ambiguous + batch.ambiguous,
  };
  console.log(
    `  ${describe(next)}; cursor=${batch.cursor.citingDecisionId}:${batch.cursor.citationId}`,
  );
  return await walk(batch.cursor, next);
};

const totals = await walk(parseCursor(process.argv), {
  scanned: 0,
  resolved: 0,
  uniqueKey: 0,
  ambiguous: 0,
});

console.log(`Done. ${describe(totals)}.`);

process.exit(0);
