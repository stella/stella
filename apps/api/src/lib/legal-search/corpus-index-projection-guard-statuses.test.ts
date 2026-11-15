import { panic } from "better-result";
import { expect, test } from "bun:test";

import { compareCodeUnit } from "@stll/collation";

import {
  CORPUS_INDEX_INTENT_STATUSES,
  CORPUS_INDEX_INTENT_TRANSITIONS,
  CORPUS_INDEX_QUIESCENT_INTENT_STATUSES,
} from "@/api/lib/legal-search/corpus-index-projection-contract";

/**
 * The guard functions spell the intent statuses as SQL literals. Compare the
 * newest definition of each with the TypeScript contract, so a new status is
 * decided in both places.
 */
const DRIZZLE_DIR = new URL("../../../drizzle/", import.meta.url);

const newestDefinition = async (functionName: string): Promise<string> => {
  const migrations = [
    ...new Bun.Glob("*/migration.sql").scanSync(Bun.fileURLToPath(DRIZZLE_DIR)),
  ].toSorted(compareCodeUnit);
  const header = `FUNCTION "${functionName}"`;
  for (const migration of migrations.toReversed()) {
    // db-await-in-loop: reads files newest first and stops at the first match
    const text = await Bun.file(new URL(migration, DRIZZLE_DIR)).text();
    const statement = text
      .split("--> statement-breakpoint")
      .find((part) => part.includes(header));
    if (statement !== undefined) {
      return statement;
    }
  }
  return panic(`No migration defines ${functionName}`);
};

const literals = (list: string) =>
  [...list.matchAll(/'([a-z_]+)'/gu)]
    .flatMap(([, literal]) => (literal === undefined ? [] : [literal]))
    .toSorted(compareCodeUnit);

test("the transition function admits exactly the contract's transitions", async () => {
  const definition = await newestDefinition(
    "corpus_index_projection_intent_transition_allowed",
  );
  const parsed = Object.fromEntries(
    [
      ...definition.matchAll(
        /WHEN '([a-z_]+)' THEN to_status (?:IN \(([^)]*)\)|= ('[a-z_]+'))/gu,
      ),
    ].map((match) => [match[1], literals(match[2] ?? match[3] ?? "")]),
  );
  const expected = Object.fromEntries(
    Object.entries(CORPUS_INDEX_INTENT_TRANSITIONS)
      .filter(([, targets]) => targets.length > 0)
      .map(([from, targets]) => [from, [...targets].toSorted(compareCodeUnit)]),
  );
  expect(parsed).toEqual(expected);
});

test("the state guard's status lists follow the contract", async () => {
  const definition = await newestDefinition(
    "guard_corpus_index_projection_state",
  );
  const erasure = /intent\."status" NOT IN \(([^)]*)\)/u.exec(definition);
  expect(literals(erasure?.[1] ?? "")).toEqual(
    [...CORPUS_INDEX_QUIESCENT_INTENT_STATUSES].toSorted(compareCodeUnit),
  );
  // A state may name its revision in every status a revision reaches after
  // `applied`, except a stalled cleanup, which an operator resolves.
  const history = /intent\."status" IN \(([^)]*)\)/u.exec(definition);
  const reachable = new Set<string>(["applied"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const status of [...reachable]) {
      for (const next of CORPUS_INDEX_INTENT_TRANSITIONS[
        CORPUS_INDEX_INTENT_STATUSES.find((known) => known === status) ??
          panic(`Unknown status ${status}`)
      ]) {
        if (!reachable.has(next)) {
          reachable.add(next);
          grew = true;
        }
      }
    }
  }
  reachable.delete("cleanup_stalled");
  expect(literals(history?.[1] ?? "")).toEqual(
    [...reachable].toSorted(compareCodeUnit),
  );
});
