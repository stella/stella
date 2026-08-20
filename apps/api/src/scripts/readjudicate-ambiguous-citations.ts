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

const BATCH = 2000;

const parseCursor = (
  argv: readonly string[],
): CitationResolutionCursor | null => {
  const index = argv.indexOf("--after");
  if (index === -1) {
    return null;
  }
  const value = argv.at(index + 1);
  const [citingDecisionId, citationId] = value?.split(":") ?? [];
  if (citingDecisionId === undefined || citationId === undefined) {
    panic("--after expects <citingDecisionId>:<citationId>");
  }
  return { citingDecisionId, citationId };
};

let after = parseCursor(process.argv);
const totals = { scanned: 0, resolved: 0, adjudicated: 0, ambiguous: 0 };

while (true) {
  // oxlint-disable-next-line no-await-in-loop -- keyset walk: each batch's cursor comes from the previous one
  const batch = await readjudicateAmbiguousCitations(
    async (fn) => await rootDb.transaction(fn),
    { limit: BATCH, after },
  );
  if (batch.scanned === 0 || batch.cursor === null) {
    break;
  }
  totals.scanned += batch.scanned;
  totals.resolved += batch.resolved;
  totals.adjudicated += batch.adjudicated;
  totals.ambiguous += batch.ambiguous;
  after = batch.cursor;
  console.log(
    `  ${totals.scanned} re-examined, ${totals.resolved} resolved (${totals.adjudicated} by adjudication), ${totals.ambiguous} still ambiguous; cursor=${after.citingDecisionId}:${after.citationId}`,
  );
}

console.log(
  `Done. ${totals.scanned} re-examined, ${totals.resolved} resolved (${totals.adjudicated} by adjudication), ${totals.ambiguous} still ambiguous.`,
);

process.exit(0);
