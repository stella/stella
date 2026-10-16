// Edition screening proof and index measurements, outside the per-PR suite.
//
//   bun run prove:editions [--source us-sdn] [--directory /path/to/editions]
//
// Reads every source from the checked-in fixtures, or from local publisher
// files named as below when --directory is given; it never fetches. A source
// it cannot load is reported NOT COVERED; any incomplete screening fails.
import { panic } from "better-result";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { EntityIndex } from "@stll/fuzzy-search";

import type { ParsedList, SanctionsEntry, SanctionsSource } from "../src/entry";
import {
  buildScreeningIndex,
  buildScreeningIndexCooperatively,
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
import type { ScreeningIndex } from "../src/screening";
import { compactLists } from "../src/test-fixtures/compact-lists";
import { largeOfacSdnXml } from "../src/test-fixtures/large-ofac-list";
import { processPeakMemoryBytes } from "../src/test-fixtures/process-peak-memory";

const FIXTURES = path.join(import.meta.dir, "..", "src", "fixtures");
const FILES = {
  eu: "eu.xml",
  un: "un.xml",
  cz: "Vnitrostatni_sankcni_seznam_????_??_??.csv",
  "us-sdn": "ofac-sdn.xml",
  "us-non-sdn": "ofac-non-sdn.xml",
  uk: "uk.xml",
  ch: "seco.xml",
} as const satisfies Record<SanctionsSource, string>;
// The interactive matcher deadline (SANCTIONS_MATCHER_CONFIG.deadlineMs).
const MAX_P99_MS = 250;
// Default API container limit in docker-compose.selfhost.yml.
const API_MEMORY_BUDGET_BYTES = 2 * 1024 ** 3;
const REPETITIONS = 5;
const SYNTHETIC_OFAC_ENTRIES = 20_000;

const { values } = parseArgs({
  options: {
    source: { type: "string", multiple: true },
    directory: { type: "string" },
    // Internal: measure one edition in a fresh process, so its peak is its own.
    measure: { type: "string" },
  },
});
const directory = values.directory ?? FIXTURES;

// Cross-script common-name pressure, including short and organisation names.
const PERSON_NAMES = [
  "John Smith",
  "José García",
  "François Martin",
  "Müller",
  "Mohammed",
  "Muhammad Hassan",
  "Mohammed Ali",
  "محمد علي",
  "Alexander Ivanov",
  "Александр Иванов",
  "Wang Wei",
  "王伟",
  "Jan Novák",
  "Ján Kováč",
];
const ORGANISATION_NAMES = [
  "International Trading",
  "General Trading Company",
  "Bank",
  "Al Hassan Trading",
  "Газпром",
  "中国银行",
  "Česká obchodní společnost",
];
// Both public input limits: 24 tokens within 512 characters.
const LIMIT_NAME = Array.from({ length: 24 }, (_, token) =>
  Array.from({ length: 20 }, (_letter, letter) =>
    String.fromCodePoint(97 + ((token * 7 + letter * 11) % 26)),
  ).join(""),
)
  .join(" ")
  .slice(0, 512);
const QUERIES = [
  { name: LIMIT_NAME, entityType: "person" as const },
  ...PERSON_NAMES.map((name) => ({ name, entityType: "person" as const })),
  ...ORGANISATION_NAMES.map((name) => ({
    name,
    entityType: "organisation" as const,
  })),
];

type EditionProof =
  | {
      status: "complete";
      source: SanctionsSource;
      entries: number;
      aliases: number;
      queries: number;
      p99Ms: number;
      maxWorkShare: number;
    }
  | {
      status: "incomplete";
      source: SanctionsSource;
      query: string;
      reason: "work-limit" | "truncated";
    }
  | {
      status: "not-covered";
      source: SanctionsSource;
      reason: "missing-file" | "parse-failed";
    };

const editionFile = async (
  source: SanctionsSource,
): Promise<string | undefined> => {
  const pattern = new Bun.Glob(FILES[source]);
  const names = (await readdir(directory)).filter((name) =>
    pattern.match(name),
  );
  return names.length === 1
    ? path.join(directory, names[0] ?? panic("Missing edition file"))
    : undefined;
};

const parseEdition = async (
  source: SanctionsSource,
  file: string,
): Promise<ParsedList | undefined> => {
  const input = () => Bun.file(file).stream();
  switch (source) {
    case "eu":
      return (await parseEuList(input())).unwrapOr(undefined);
    case "un":
      return (await parseUnList(input())).unwrapOr(undefined);
    case "cz":
      return parseCzList({
        csv: await Bun.file(file).text(),
        fileNameOrUrl: path.basename(file),
      }).unwrapOr(undefined);
    case "us-sdn":
    case "us-non-sdn":
      return (await parseOfacList(source, input())).unwrapOr(undefined);
    case "uk":
      return (await parseUkList(input())).unwrapOr(undefined);
    case "ch":
      return (await parseSecoList(input())).unwrapOr(undefined);
    default: {
      source satisfies never;
      return panic("Unknown sanctions source");
    }
  }
};

const quantile = (sorted: readonly number[], share: number) =>
  sorted.at(Math.min(sorted.length - 1, Math.floor(sorted.length * share))) ??
  0;

const proveEdition = async (source: SanctionsSource): Promise<EditionProof> => {
  const file = await editionFile(source);
  if (file === undefined) {
    return { status: "not-covered", source, reason: "missing-file" };
  }
  const list = await parseEdition(source, file);
  if (list === undefined || list.entries.length === 0) {
    return { status: "not-covered", source, reason: "parse-failed" };
  }
  const index = buildScreeningIndex([list]);
  const milliseconds: number[] = [];
  const workShares: number[] = [];
  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    for (const query of QUERIES) {
      const started = performance.now();
      const result = screen(index, query, {
        cutoff: DEFAULT_CUTOFF,
        // A shortlist limit is not completeness; return every match.
        limit: list.entries.length,
        onWork: ({ spent, limit }) => {
          workShares.push(spent / limit);
        },
      });
      milliseconds.push(performance.now() - started);
      if (result.isErr()) {
        return {
          status: "incomplete",
          source,
          query: query.name,
          reason: "work-limit",
        };
      }
      if (result.value.truncated) {
        return {
          status: "incomplete",
          source,
          query: query.name,
          reason: "truncated",
        };
      }
    }
  }
  milliseconds.sort((left, right) => left - right);
  return {
    status: "complete",
    source,
    entries: list.entries.length,
    aliases: index.names.aliases.length,
    queries: milliseconds.length,
    p99Ms: quantile(milliseconds, 0.99),
    maxWorkShare: Math.max(...workShares),
  };
};

type IndexMeasurement = {
  edition: string;
  entries: number;
  aliases: number;
  buildMs: number;
  serializedBytes: number;
  serializeMs: number;
  deserializeMs: number;
  nativeBytes: number;
  postings: number;
  processPeakRssBytes: number;
};

const measureIndex = async (
  edition: string,
  lists: readonly ParsedList[],
): Promise<IndexMeasurement> => {
  Bun.gc(true);
  let started = performance.now();
  // The serving path: cooperative steps, native finish on the worker pool.
  const index: ScreeningIndex = await buildScreeningIndexCooperatively(
    lists,
    async () => {
      await Promise.resolve();
    },
  );
  const buildMs = performance.now() - started;
  const processPeakRssBytes = processPeakMemoryBytes();
  started = performance.now();
  const bytes = index.names.candidates.toBytes();
  const serializeMs = performance.now() - started;
  started = performance.now();
  EntityIndex.fromBytes(bytes);
  const deserializeMs = performance.now() - started;
  return {
    edition,
    entries: index.entries.length,
    aliases: index.names.aliases.length,
    buildMs,
    serializedBytes: bytes.byteLength,
    serializeMs,
    deserializeMs,
    nativeBytes: index.names.candidates.nativeBytes,
    postings: index.names.candidates.postingCount,
    processPeakRssBytes,
  };
};

// Many aliases repeating one spelling, so self-joins fan out on every posting.
const repeatedJoinList = (): ParsedList => {
  const template = compactLists([1, 0, 0]).at(0)?.entries.at(0);
  if (template === undefined) {
    return panic("Missing compact list template");
  }
  return {
    version: { source: "eu", publishedAt: "2026-10-01", fileId: null },
    entries: Array.from({ length: 20_000 }, (_, entry): SanctionsEntry => ({
      ...template,
      source: "eu",
      sourceId: `repeated-${entry}`,
      names: [
        { name: `Ali Ali Ali Hassan${entry}`, quality: "strong" },
        { name: `Mohammed Mohammed Ali${entry}`, quality: "weak" },
      ],
    })),
  };
};

const MEASURED_EDITIONS = {
  "synthetic-ofac-sdn": async () => [
    (
      await parseOfacList(
        "us-sdn",
        new Blob([largeOfacSdnXml(SYNTHETIC_OFAC_ENTRIES)]).stream(),
      )
    ).unwrap("The synthetic OFAC edition must parse"),
  ],
  "compact-lists": () => compactLists(),
  "repeated-self-joins": () => [repeatedJoinList()],
} as const satisfies Record<string, () => ParsedList[] | Promise<ParsedList[]>>;

const isMeasuredEdition = (
  name: string,
): name is keyof typeof MEASURED_EDITIONS => name in MEASURED_EDITIONS;

if (values.measure !== undefined) {
  const edition = values.measure;
  assert.ok(isMeasuredEdition(edition), "--measure must name a fixture");
  const measured = await measureIndex(
    edition,
    await MEASURED_EDITIONS[edition](),
  );
  console.log(JSON.stringify(measured));
  process.exit(0);
}

const sources = Object.values(SANCTIONS_SOURCES)
  .map(({ id }) => id)
  .filter((id) => values.source === undefined || values.source.includes(id));
assert.ok(sources.length > 0, "--source must name a supported source");

const proofs: EditionProof[] = [];
for (const source of sources) {
  const proof = await proveEdition(source);
  proofs.push(proof);
  console.log(
    JSON.stringify(
      proof.status === "not-covered"
        ? { ...proof, status: "NOT COVERED" }
        : proof,
    ),
  );
}

for (const edition of Object.keys(MEASURED_EDITIONS)) {
  const child = Bun.spawnSync(
    [process.execPath, import.meta.path, "--measure", edition],
    { stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(
    child.exitCode,
    0,
    `${edition}: measurement failed: ${child.stderr.toString()}`,
  );
  const measured: unknown = JSON.parse(child.stdout.toString());
  assert.ok(
    typeof measured === "object" &&
      measured !== null &&
      "processPeakRssBytes" in measured &&
      typeof measured.processPeakRssBytes === "number",
    `${edition}: measurement output is invalid`,
  );
  console.log(
    JSON.stringify({ ...measured, budgetBytes: API_MEMORY_BUDGET_BYTES }),
  );
  assert.ok(
    measured.processPeakRssBytes <= API_MEMORY_BUDGET_BYTES,
    `${edition}: process peak memory exceeds the API memory budget`,
  );
}

const incomplete = proofs.filter(({ status }) => status === "incomplete");
assert.equal(
  incomplete.length,
  0,
  `Incomplete screening: ${incomplete.map(({ source }) => source).join(", ")}`,
);
const slow = proofs.filter(
  (proof) => proof.status === "complete" && proof.p99Ms > MAX_P99_MS,
);
assert.equal(
  slow.length,
  0,
  `Common-name p99 exceeds ${MAX_P99_MS} ms: ${slow.map(({ source }) => source).join(", ")}`,
);
