/**
 * Prints per-class results of the labeled name-matching corpus.
 *
 *   bun apps/api/scripts/name-matching-corpus.ts [--failures]
 */
import {
  measureNameMatchingCorpus,
  NAME_MATCHING_MODES,
} from "@/api/mcp/name-matching-corpus.measure";
import type { NameMatchingTally } from "@/api/mcp/name-matching-corpus.measure";

const showFailures = process.argv.includes("--failures");
const report = await measureNameMatchingCorpus();

const percent = (part: number, whole: number) =>
  `${((part / whole) * 100).toFixed(1)}%`;

const describeRate = (tally: NameMatchingTally) =>
  tally.expectation === "redact"
    ? `recall ${percent(tally.passed, tally.total)}`
    : `false positives ${String(tally.total - tally.passed)} (${percent(tally.total - tally.passed, tally.total)})`;

for (const mode of NAME_MATCHING_MODES) {
  const tallies = report[mode];
  if (tallies === undefined) {
    continue;
  }
  console.log(`\n${mode}`);
  console.log("class                          label   held/total  rate");
  for (const [kind, tally] of Object.entries(tallies)) {
    const held = `${String(tally.passed)}/${String(tally.total)}`;
    console.log(
      `${kind.padEnd(30)} ${tally.expectation.padEnd(7)} ${held.padEnd(11)} ${describeRate(tally)}`,
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
