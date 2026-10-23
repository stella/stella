import { panic, Result } from "better-result";
// Fixture-backed common-name completeness proof and edition resource measurements.
// No publisher requests: --directory must contain local editions using fixture filenames.
import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs } from "node:util";

import type { ParsedList, SanctionsSource } from "../src/entry";
import {
  buildScreeningIndex,
  DEFAULT_CUTOFF,
  parseCzList,
  parseEuList,
  parseOfacList,
  parseSecoList,
  parseUkList,
  parseUnList,
  SANCTIONS_SOURCES,
  screen,
} from "../src/index";
import type { ScreeningIndex, ScreeningWorkUsage } from "../src/screening";
import { compactLists } from "../src/test-fixtures/compact-lists";
import { processPeakMemoryBytes } from "../src/test-fixtures/process-peak-memory";

const { values } = parseArgs({
  options: {
    source: { type: "string", multiple: true },
    directory: {
      type: "string",
      default: path.join(import.meta.dir, "../src/fixtures"),
    },
    copies: { type: "string", default: "1" },
    generated: { type: "boolean", default: false },
    // The nightly proof commits every fixture, so an unreadable edition there
    // is a defect rather than missing local data.
    "require-coverage": { type: "boolean", default: false },
  },
});
const copies = Number(values.copies);
assert.ok(
  Number.isInteger(copies) && copies >= 1 && copies <= 3,
  "--copies must be one to three",
);
const MAX_BYTES = 64_000_000;
const REPETITIONS = 5;
// Default API process memory limit in docker-compose.selfhost.yml.
const MAX_PROCESS_PEAK_RSS_BYTES = 2 * 1024 ** 3;
const FIXTURE_NAMES = {
  eu: "eu.xml",
  un: "un.xml",
  cz: "Vnitrostatni_sankcni_seznam_2026_07_23.csv",
  "us-sdn": "ofac-sdn.xml",
  "us-non-sdn": "ofac-non-sdn.xml",
  uk: "uk.xml",
  ch: "seco.xml",
} as const satisfies Record<SanctionsSource, string>;

type EditionCoverage =
  | {
      status: "COVERED";
      source: SanctionsSource;
      list: ParsedList;
      fixtureBytes: number;
    }
  | { status: "NOT COVERED"; source: SanctionsSource; reason: string };

const loadEdition = async (
  source: SanctionsSource,
): Promise<EditionCoverage> => {
  const fileName = FIXTURE_NAMES[source];
  const file = Bun.file(path.join(values.directory, fileName));
  if (!(await file.exists())) {
    return {
      status: "NOT COVERED",
      source,
      reason: "edition fixture is absent",
    };
  }
  if (file.size > MAX_BYTES) {
    return {
      status: "NOT COVERED",
      source,
      reason: "edition fixture exceeds byte limit",
    };
  }
  const parse = async () => {
    switch (source) {
      case "eu":
        return await parseEuList(file.stream());
      case "un":
        return await parseUnList(file.stream());
      case "cz":
        return parseCzList({ csv: await file.text(), fileNameOrUrl: fileName });
      case "us-sdn":
      case "us-non-sdn":
        return await parseOfacList(source, file.stream());
      case "uk":
        return await parseUkList(file.stream());
      case "ch":
        return await parseSecoList(file.stream());
      default: {
        source satisfies never;
        return panic("Unknown sanctions source");
      }
    }
  };
  const parsed = await parse();
  if (parsed.isErr()) {
    return { status: "NOT COVERED", source, reason: parsed.error.message };
  }
  return {
    status: "COVERED",
    source,
    list: parsed.value,
    fixtureBytes: file.size,
  };
};

// Cross-script common-name pressure, including ambiguous short queries and
// organisations; returning a shortlist must never hide incomplete scoring.
const PERSON_NAMES = [
  "John Smith",
  "James Brown",
  "José García",
  "François Martin",
  "Müller",
  "Mohammed",
  "Muhammad",
  "Ali",
  "Hassan",
  "Mohammed Ali",
  "Mohammed Mohammed",
  "Mohammed Mohammed Mohammed",
  "Muhammad Hassan",
  "محمد علي",
  "حسن",
  "Alexander Ivanov",
  "Sergey Petrov",
  "Александр Иванов",
  "Сергей Петров",
  "Wang Wei",
  "Li Wei",
  "Zhang Wei",
  "王伟",
  "李伟",
  "Jan Novák",
  "Jiří Svoboda",
  "Ján Kováč",
  "Štefan Horváth",
];
const ORGANISATION_NAMES = [
  "International Trading",
  "Global Trading Company",
  "General Trading",
  "Bank",
  "Al Hassan Trading",
  "Mohammed Ali Trading",
  "Газпром",
  "Российский банк",
  "China Trading",
  "中国银行",
  "Česká obchodní společnost",
  "Slovenská obchodná spoločnosť",
];
const variedTokens = Array.from({ length: 24 }, (_, token) =>
  Array.from({ length: token === 23 ? 29 : 20 }, (_letter, letter) =>
    String.fromCodePoint(97 + ((token * 7 + letter * 11) % 26)),
  ).join(""),
).join(" ");
const distinctHan = Array.from({ length: 512 }, (_, offset) =>
  String.fromCodePoint(0x4e_00 + offset),
).join("");
assert.equal(
  variedTokens.length,
  512,
  "Stress query must exercise the public input length limit",
);
const STRESS_NAMES = [
  variedTokens,
  distinctHan,
  Array.from(
    { length: 24 },
    (_, index) =>
      PERSON_NAMES[index % PERSON_NAMES.length]?.split(" ").at(0) ??
      panic("Missing common-name probe"),
  ).join(" "),
];
const QUERIES = [
  ...STRESS_NAMES.map((name) => ({ name, entityType: "person" as const })),
  ...PERSON_NAMES.map((name) => ({ name, entityType: "person" as const })),
  ...ORGANISATION_NAMES.map((name) => ({
    name,
    entityType: "organisation" as const,
  })),
];

const quantile = (sorted: readonly number[], share: number) =>
  sorted.at(Math.min(sorted.length - 1, Math.floor(sorted.length * share))) ??
  0;

// Keep every built index resident, matching simultaneous edition residency.
const residentIndexes: ScreeningIndex[] = [];
const measure = (
  label: string,
  lists: readonly ParsedList[],
  fixtureBytes: number | null,
) => {
  assert.ok(
    lists.every((list) => list.entries.length > 0),
    `${label}: fixture edition is empty`,
  );
  Bun.gc(true);
  const copyBuildMs: number[] = [];
  let index: ScreeningIndex | undefined;
  for (let copy = 0; copy < copies; copy += 1) {
    const start = performance.now();
    const built = buildScreeningIndex(lists);
    copyBuildMs.push(performance.now() - start);
    residentIndexes.push(built);
    index ??= built;
  }
  assert.ok(index, "At least one index must be built");
  const serializationStart = performance.now();
  const serializedBytes = index.names.entities.toBytes().byteLength;
  const serializationMs = performance.now() - serializationStart;
  const rssAfterBuild = process.memoryUsage().rss;
  Bun.gc(true);
  const retainedMemoryAfterGc = process.memoryUsage();
  const entryCount = lists.reduce((sum, list) => sum + list.entries.length, 0);
  const milliseconds: number[] = [];
  let maxWork = 0;
  const observeWork = ({ spent }: ScreeningWorkUsage) => {
    maxWork = Math.max(maxWork, spent);
  };
  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    for (const query of QUERIES) {
      const start = performance.now();
      const screened = screen(index, query, {
        cutoff: DEFAULT_CUTOFF,
        limit: entryCount,
        onWork: observeWork,
      });
      if (screened.isErr()) {
        panic(`${label}: common-name screening must complete`, screened.error);
      }
      const result = screened.value;
      milliseconds.push(performance.now() - start);
      assert.equal(
        result.truncated,
        false,
        `${label}: common-name screening is incomplete`,
      );
    }
  }
  milliseconds.sort((left, right) => left - right);
  const report = {
    status: "COVERED",
    fixture: label,
    editions: lists.map((list) => list.version),
    fixtureBytes,
    serializedBytes,
    serializationMs,
    nativeBytes: index.names.entities.nativeBytes,
    postingCount: index.names.entities.postingCount,
    entries: entryCount,
    aliases: index.names.aliases.length,
    buildMs: Math.max(...copyBuildMs),
    copyBuildMs,
    copies,
    rssAfterBuild,
    retainedMemoryAfterGc,
    processPeakRssBytes: processPeakMemoryBytes(),
    queries: milliseconds.length,
    p99Ms: quantile(milliseconds, 0.99),
    maxMs: quantile(milliseconds, 1),
    maxWork,
    budgetProcessPeakRssBytes: MAX_PROCESS_PEAK_RSS_BYTES,
  };
  console.log(JSON.stringify(report));
  assert.ok(
    report.processPeakRssBytes <= MAX_PROCESS_PEAK_RSS_BYTES,
    `${label}: peak RSS exceeds the default API 2GiB limit`,
  );
};

const sources = Object.values(SANCTIONS_SOURCES).filter(
  ({ id }) => values.source === undefined || values.source.includes(id),
);
assert.ok(
  sources.length > 0 &&
    (values.source === undefined ||
      values.source.every((source) => sources.some(({ id }) => id === source))),
  "--source must name a supported sanctions source",
);
const failures: string[] = [];
const notCovered: SanctionsSource[] = [];
for (const { id: source } of sources) {
  // Script boundary: retain coverage for every edition even if one fixture fails.
  try {
    const loaded = await Result.tryPromise({
      try: async () => loadEdition(source),
      catch: () =>
        ({
          status: "NOT COVERED",
          source,
          reason: "edition fixture cannot be read",
        }) as const satisfies EditionCoverage,
    });
    const coverage = loaded.isOk() ? loaded.value : loaded.error;
    switch (coverage.status) {
      case "NOT COVERED":
        notCovered.push(source);
        console.log(JSON.stringify(coverage));
        break;
      case "COVERED":
        measure(source, [coverage.list], coverage.fixtureBytes);
        break;
      default:
        coverage satisfies never;
        panic("Unhandled edition coverage status");
    }
  } catch (error) {
    failures.push(source);
    console.error(
      JSON.stringify({
        source,
        status: "FAILED",
        reason: error instanceof Error ? error.message : "UnknownError",
      }),
    );
  }
}
if (values.generated) {
  const lists = compactLists();
  // Every edition shares repeated joins: one lookup must account for the full fanout.
  for (const list of lists) {
    for (const entry of list.entries) {
      entry.names.push({
        name: "Mohammed Mohammed Mohammed",
        quality: "strong",
      });
    }
  }
  measure("generated-compact-editions-repeated-joins", lists, null);
}
console.log(
  JSON.stringify({
    residentIndexes: residentIndexes.length,
    notCovered,
    failures,
  }),
);
assert.equal(
  failures.length,
  0,
  `Edition proof failed: ${failures.join(", ")}`,
);
if (values["require-coverage"]) {
  assert.equal(
    notCovered.length,
    0,
    `Edition proof did not cover: ${notCovered.join(", ")}`,
  );
}
