// Name-screening evaluation.
//
//   bun run evaluate -- --eu <eu.xml> --un <un.xml> --cz <cz.csv> [--per-category 300]
//   bun run evaluate -- --write-sample
//
// Without list paths it evaluates the checked-in fixture excerpts. The full
// run takes the official downloads; nothing here touches the network.
// `--write-sample` regenerates `sample.json` from the fixtures, which the test
// suite replays as a regression gate.

import path from "node:path";
import { parseArgs } from "node:util";

import { parseCzList } from "../src/cz";
import type { ParsedList } from "../src/entry";
import { parseEuList } from "../src/eu";
import { evaluate, generateCases } from "../src/evaluation/evaluation";
import { buildScreeningIndex } from "../src/screening";
import { parseUnList } from "../src/un";

const CUTOFFS = [0.7, 0.75, 0.8, 0.85, 0.9];
const FIXTURES = path.join(import.meta.dir, "..", "src", "fixtures");
const CZ_FIXTURE = "Vnitrostatni_sankcni_seznam_2026_07_23.csv";
const SAMPLE = path.join(
  import.meta.dir,
  "..",
  "src",
  "evaluation",
  "sample.json",
);
const SAMPLE_SEED = 7;
const SAMPLE_PER_CATEGORY = 6;

const { values } = parseArgs({
  options: {
    eu: { type: "string", default: path.join(FIXTURES, "eu.xml") },
    un: { type: "string", default: path.join(FIXTURES, "un.xml") },
    cz: { type: "string", default: path.join(FIXTURES, CZ_FIXTURE) },
    "per-category": { type: "string", default: "300" },
    seed: { type: "string", default: "1" },
    "write-sample": { type: "boolean", default: false },
  },
});

const lists: ParsedList[] = [
  (await parseEuList(Bun.file(values.eu).stream())).unwrap(),
  (await parseUnList(Bun.file(values.un).stream())).unwrap(),
  parseCzList({
    csv: await Bun.file(values.cz).text(),
    fileNameOrUrl: values.cz,
  }).unwrap(),
];

if (values["write-sample"]) {
  const cases = generateCases(lists, {
    seed: SAMPLE_SEED,
    perCategory: SAMPLE_PER_CATEGORY,
  });
  await Bun.write(SAMPLE, `${JSON.stringify(cases, null, 2)}\n`);
  console.log(`wrote ${cases.length} cases to ${SAMPLE}`);
  process.exit(0);
}

const started = performance.now();
const index = buildScreeningIndex(lists);
const buildMilliseconds = performance.now() - started;

const cases = generateCases(lists, {
  seed: Number(values.seed),
  perCategory: Number(values["per-category"]),
});
const report = evaluate(lists, cases, CUTOFFS);

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const latency = report.milliseconds.toSorted((left, right) => left - right);
const quantile = (share: number) =>
  (
    latency[Math.min(latency.length - 1, Math.floor(latency.length * share))] ??
    0
  ).toFixed(1);

console.log(
  `${lists.map((list) => `${list.version.source} ${list.version.publishedAt}: ${list.entries.length} entries`).join("; ")}`,
);
console.log(
  `index: ${index.names.aliases.length} names, ${index.names.folded.strings.length} folded strings, built in ${buildMilliseconds.toFixed(0)} ms`,
);
console.log(
  `screening latency over ${latency.length} queries: p50 ${quantile(0.5)} ms, p95 ${quantile(0.95)} ms, max ${quantile(1)} ms\n`,
);
console.log(
  "| cutoff | precision | recall | false positive rate | ambiguous flagged | alerts per query |",
);
console.log("| --- | --- | --- | --- | --- | --- |");
for (const row of report.rows) {
  console.log(
    `| ${row.cutoff} | ${percent(row.precision)} | ${percent(row.recall)} | ${percent(row.falsePositiveRate)} | ${percent(row.ambiguousFlagRate)} | ${row.alertsPerQuery.toFixed(2)} |`,
  );
}
const categories = Object.keys(report.rows[0]?.byCategory ?? {});
console.log(
  `\n| category (n=${values["per-category"]} each) | ${CUTOFFS.join(" | ")} |`,
);
console.log(`| --- | ${CUTOFFS.map(() => "---").join(" | ")} |`);
for (const category of categories) {
  console.log(
    `| ${category} | ${report.rows.map((row) => percent(row.byCategory[category] ?? 0)).join(" | ")} |`,
  );
}
