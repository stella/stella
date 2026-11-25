/**
 * The site-note tools' contract, through local harnesses only.
 *
 * `check` (the default) is deterministic: the reference calls for every case
 * must score full marks through the same schemas and content guard the tools
 * use, and the leaking calls must be caught. `prompts` prints one task per
 * case for a local coding-agent harness; `score <results.jsonl>` scores what
 * the harness answered, one `{ "caseId", "calls": [{ "name", "args" }] }` per
 * line, and keeps the raw input of every call the schema refused.
 */
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  LEAKING_CALLS,
  REFERENCE_CALLS,
  scoreSiteNotesRun,
  SITE_NOTES_CASES,
  siteNotesPrompt,
} from "./lib/site-notes-cases";

const CHECKS = [
  "readsFirst",
  "parses",
  "clean",
  "confirms",
  "replacesOrRemoves",
  "adds",
] as const;

const table = (rows: readonly ReturnType<typeof scoreSiteNotesRun>[]) =>
  [
    `| case | ${CHECKS.join(" | ")} |`,
    `| --- | ${CHECKS.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) =>
        `| ${row.caseId} | ${CHECKS.map((check) => (row[check] ? "yes" : "no")).join(" | ")} |`,
    ),
  ].join("\n");

const passes = (row: ReturnType<typeof scoreSiteNotesRun>) =>
  CHECKS.every((check) => row[check]);

/** One harness answer: the case and the calls it made, in order. */
const harnessRunSchema = v.object({
  caseId: v.string(),
  calls: v.array(v.object({ name: v.string(), args: v.unknown() })),
});

const [mode = "check", resultsPath] = process.argv.slice(2);

if (mode === "prompts") {
  for (const testCase of SITE_NOTES_CASES) {
    process.stdout.write(
      `${JSON.stringify({ caseId: testCase.id, prompt: siteNotesPrompt(testCase) })}\n`,
    );
  }
} else if (mode === "score") {
  if (resultsPath === undefined) {
    process.stderr.write("usage: site-notes-local.ts score <results.jsonl>\n");
    process.exit(2);
  }
  const rows = readFileSync(resultsPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const run = v.parse(harnessRunSchema, JSON.parse(line));
      const testCase = SITE_NOTES_CASES.find(({ id }) => id === run.caseId);
      return testCase === undefined
        ? []
        : [scoreSiteNotesRun(testCase, run.calls)];
    });
  process.stdout.write(`${table(rows)}\n\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: rows.filter(passes).length, runs: rows.length, rejected: rows.flatMap(({ caseId, rejected }) => rejected.map((args) => ({ caseId, args }))) }, null, 2)}\n`,
  );
} else {
  const reference = SITE_NOTES_CASES.map((testCase) =>
    scoreSiteNotesRun(testCase, REFERENCE_CALLS[testCase.id] ?? []),
  );
  const leaking = SITE_NOTES_CASES.flatMap((testCase) => {
    const calls = LEAKING_CALLS[testCase.id];
    return calls === undefined ? [] : [scoreSiteNotesRun(testCase, calls)];
  });
  process.stdout.write(`Reference calls\n\n${table(reference)}\n\n`);
  process.stdout.write(
    `Leaking calls (must fail "clean")\n\n${table(leaking)}\n\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ kind: "local-deterministic-contract-eval", modelChoice: "NOT COVERED", referencePassed: reference.filter(passes).length, cases: reference.length, leakingCaught: leaking.filter((row) => !row.clean).length, leaking: leaking.length })}\n`,
  );
  if (!reference.every(passes) || leaking.some((row) => row.clean)) {
    process.exitCode = 1;
  }
}
