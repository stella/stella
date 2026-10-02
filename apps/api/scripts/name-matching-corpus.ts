/**
 * Prints per-class results of the labeled name-matching corpus.
 *
 *   bun apps/api/scripts/name-matching-corpus.ts [--failures]
 */
import {
  measureNameMatchingCorpus,
  NAME_MATCHING_MATCHERS,
} from "@/api/tests/helpers/name-matching-corpus";
import type { NameMatchingTally } from "@/api/tests/helpers/name-matching-corpus";

const showFailures = process.argv.includes("--failures");
const report = await measureNameMatchingCorpus();

const describeTally = (tally: NameMatchingTally) => {
  const counts = `${String(tally.held)}/${String(tally.total)} control ${String(tally.heldByControl)}/${String(tally.total)}`;
  const split = `split failures ${String(tally.splitFailures)}`;
  return tally.expectation === "redact"
    ? `${counts} attributed ${String(tally.attributed)}/${String(tally.total - tally.heldByControl)} ${split}`
    : `${counts} false positives ${String(tally.total - tally.held)} attributed ${String(tally.attributedFalsePositives)} ${split}`;
};

for (const matcher of NAME_MATCHING_MATCHERS) {
  console.log(`\n${matcher}`);
  for (const [kind, tally] of Object.entries(report[matcher])) {
    console.log(
      `${kind.padEnd(30)} ${tally.expectation.padEnd(7)} ${describeTally(tally)}`,
    );
    if (showFailures) {
      for (const failure of tally.failures) {
        console.log(
          `    ${JSON.stringify(failure.surface)} -> ${JSON.stringify(failure.output)}`,
        );
      }
    }
  }
}
