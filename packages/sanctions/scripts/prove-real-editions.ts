import { panic } from "better-result";
// Optional publisher-edition proof, deliberately outside the per-PR test suite.
// bun run prove:real-editions [--source us-sdn] [--directory /path/to/official-editions]
// --save-directory caches publisher bytes for measured reruns.
// Local files: <source>.xml, except the original dated CZ CSV filename; no fixture fallback is permitted.
import { AssertionError } from "node:assert";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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
  discoverCzCsvUrl,
  discoverEuXmlUrl,
  SANCTIONS_SOURCES,
  screen,
} from "../src/index";
import { similarStrings } from "../src/name-match";
import type { ScreeningIndex } from "../src/screening";

const MAX_BYTES = 64_000_000;
const REQUEST_TIMEOUT_MS = 120_000;
const REPETITIONS = 5;
// The interactive matcher lease is 250ms (SANCTIONS_MATCHER_CONFIG);
// this optional proof uses the same ceiling and reports actual headroom.
const MAX_P99_MS = 250;
const { values } = parseArgs({
  options: {
    source: { type: "string", multiple: true },
    copies: { type: "string", default: "2" },
    directory: { type: "string" },
    "save-directory": { type: "string" },
  },
});

const copies = Number(values.copies);
assert.ok(
  Number.isInteger(copies) && copies >= 1 && copies <= 3,
  "--copies must be an integer from one to three (main cache plus up to two workers)",
);
// Default docker-compose.selfhost.yml API ceiling, including resident copies.
const MAX_PROCESS_PEAK_RSS_BYTES = 2 * 1024 ** 3;
// Performance target, independent of the two-minute warm-stall deadline.
const MAX_COLD_BUILD_MS = 10_000;

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

const download = async (
  source: SanctionsSource,
  address: string,
): Promise<Uint8Array> => {
  const initial = new URL(address);
  const allowedHosts = new Set<string>([
    initial.hostname,
    ...SANCTIONS_SOURCES[source].allowedRedirectHosts,
  ]);
  let url = initial;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    assert.equal(url.protocol, "https:", "Publisher downloads require HTTPS");
    assert.ok(
      url.username === "" &&
        url.password === "" &&
        (url.port === "" || url.port === "443"),
      "Publisher downloads require an ordinary HTTPS origin",
    );
    assert.ok(
      allowedHosts.has(url.hostname),
      "Publisher redirect host is not allowed",
    );
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- Each redirect URL depends on the preceding publisher response; capped at four redirects.
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      assert.ok(location, "Publisher redirect has no location");
      url = new URL(location, url);
      continue;
    }
    assert.ok(
      response.ok,
      `${source}: publisher returned HTTP ${response.status}`,
    );
    assert.ok(response.body, `${source}: publisher response has no body`);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      assert.ok(
        bytes <= MAX_BYTES,
        `${source}: publisher edition exceeds download bound`,
      );
      chunks.push(chunk);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  return panic(`${source}: too many publisher redirects`);
};

const readEdition = async (source: SanctionsSource) => {
  if (values.directory !== undefined) {
    let fileName = `${source}.xml`;
    if (source === "cz") {
      const matches = await Array.fromAsync(
        new Bun.Glob("Vnitrostatni_sankcni_seznam_????_??_??.csv").scan(
          values.directory,
        ),
      );
      assert.equal(
        matches.length,
        1,
        "Local editions must contain exactly one dated CZ CSV",
      );
      const match = matches.at(0);
      assert.ok(match, "Local CZ edition must exist");
      fileName = match;
    }
    const file = Bun.file(path.join(values.directory, fileName));
    assert.ok(
      file.size <= MAX_BYTES,
      `${source}: edition exceeds download bound`,
    );
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name ?? "",
    };
  }
  const metadata = SANCTIONS_SOURCES[source];
  if (metadata.download.kind === "dated-file") {
    const page = await download(source, metadata.download.pageUrl);
    const downloadUrl = discoverCzCsvUrl(new TextDecoder().decode(page)).unwrap(
      "CZ publisher page must identify its current edition",
    );
    return {
      bytes: await download(source, downloadUrl),
      fileName: new URL(downloadUrl).pathname,
    };
  }
  if (source === "eu" && process.env["EU_SANCTIONS_TOKEN"] === undefined) {
    const metadataBytes = await download(
      source,
      SANCTIONS_SOURCES.eu.discoveryUrl,
    );
    const publisherMetadata: unknown = JSON.parse(
      new TextDecoder().decode(metadataBytes),
    );
    const downloadUrl = discoverEuXmlUrl(publisherMetadata).unwrap(
      "EU publisher metadata must identify its current edition",
    );
    return {
      bytes: await download(source, downloadUrl),
      fileName: new URL(downloadUrl).pathname,
    };
  }
  const url = new URL(metadata.download.urls[0]);
  if (source === "eu" && process.env["EU_SANCTIONS_TOKEN"]) {
    url.searchParams.set("token", process.env["EU_SANCTIONS_TOKEN"]);
  }
  return { bytes: await download(source, url.href), fileName: url.pathname };
};

const parseEdition = async (source: SanctionsSource): Promise<ParsedList> => {
  const { bytes, fileName } = await readEdition(source);
  if (values["save-directory"] !== undefined) {
    await mkdir(values["save-directory"], { recursive: true });
    const outputName =
      source === "cz" ? path.basename(fileName) : `${source}.xml`;
    await Bun.write(path.join(values["save-directory"], outputName), bytes);
  }
  const input = new Blob([bytes]).stream();
  switch (source) {
    case "eu":
      return (await parseEuList(input)).unwrap(
        "Official EU edition must parse",
      );
    case "un":
      return (await parseUnList(input)).unwrap(
        "Official UN edition must parse",
      );
    case "cz":
      return parseCzList({
        csv: new TextDecoder().decode(bytes),
        fileNameOrUrl: fileName,
      }).unwrap("Official CZ edition must parse");
    case "us-sdn":
    case "us-non-sdn":
      return (await parseOfacList(source, input)).unwrap(
        "Official OFAC edition must parse",
      );
    case "uk":
      return (await parseUkList(input)).unwrap(
        "Official UK edition must parse",
      );
    case "ch":
      return (await parseSecoList(input)).unwrap(
        "Official SECO edition must parse",
      );
    default: {
      source satisfies never;
      return panic("Unknown sanctions source");
    }
  }
};

const quantile = (sorted: readonly number[], share: number) =>
  sorted.at(Math.min(sorted.length - 1, Math.floor(sorted.length * share))) ??
  0;

// Match the API process residency: keep all loaded source indexes alive.
const residentIndexes: ScreeningIndex[] = [];
const failures: SanctionsSource[] = [];
const proveEdition = async (source: SanctionsSource) => {
  Bun.gc(true);
  const list = await parseEdition(source);
  assert.ok(list.entries.length > 0, `${source}: official edition is empty`);
  const copyBuildMs: number[] = [];
  let index: ScreeningIndex | undefined;
  for (let copy = 0; copy < copies; copy += 1) {
    const started = performance.now();
    const built = buildScreeningIndex([list]);
    copyBuildMs.push(performance.now() - started);
    residentIndexes.push(built);
    index ??= built;
  }
  assert.ok(index, "At least one index copy must be built");
  const buildMs = Math.max(...copyBuildMs);
  const rssAfterBuild = process.memoryUsage().rss;
  Bun.gc(true);
  const retainedMemoryAfterGc = process.memoryUsage();
  let maxPosting = 0;
  let maxNeighbours = 0;
  for (const vocabulary of [index.names.folded, index.names.raw]) {
    for (let id = 0; id < vocabulary.strings.length; id += 1) {
      maxPosting = Math.max(maxPosting, vocabulary.postings.size(id));
    }
    for (const { name } of QUERIES) {
      for (const text of name.toLowerCase().split(/\s+/u)) {
        const work = {
          remaining: Number.MAX_SAFE_INTEGER,
          exhausted: false,
        };
        maxNeighbours = Math.max(
          maxNeighbours,
          similarStrings({ vocabulary, text, work }).size,
        );
        assert.ok(
          !work.exhausted,
          `${source}: neighbour probe exhausted its work budget`,
        );
      }
    }
  }
  const milliseconds: number[] = [];
  let maxWork = 0;
  const observeWork = ({ spent }: { spent: number }) => {
    maxWork = Math.max(maxWork, spent);
  };
  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    for (const query of QUERIES) {
      const start = performance.now();
      const result = screen(index, query, {
        cutoff: DEFAULT_CUTOFF,
        // Separately measure output cardinality: a UI shortlist is not a
        // candidate-completeness limit and must not make this assertion fail.
        limit: list.entries.length,
        onWork: observeWork,
      }).unwrap(`${source}: common-name screening must complete`);
      milliseconds.push(performance.now() - start);
      assert.equal(
        result.truncated,
        false,
        `${source}: common-name screening is incomplete`,
      );
    }
  }
  milliseconds.sort((left, right) => left - right);
  const report = {
    source,
    edition: list.version,
    entries: list.entries.length,
    aliases: index.names.aliases.length,
    buildMs,
    copyBuildMs,
    copies,
    rssAfterBuild,
    retainedMemoryAfterGc,
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    queries: milliseconds.length,
    p99Ms: quantile(milliseconds, 0.99),
    maxMs: quantile(milliseconds, 1),
    maxWork,
    maxTokenPosting: maxPosting,
    sampledMaxNeighbours: maxNeighbours,
    foldedVocabularySize: index.names.folded.strings.length,
    rawVocabularySize: index.names.raw.strings.length,
    budgetP99Ms: MAX_P99_MS,
    budgetColdBuildMs: MAX_COLD_BUILD_MS,
    budgetProcessPeakRssBytes: MAX_PROCESS_PEAK_RSS_BYTES,
  };
  console.log(JSON.stringify(report));
  assert.ok(
    report.p99Ms <= MAX_P99_MS,
    `${source}: common-name p99 exceeds ${MAX_P99_MS}ms`,
  );
  assert.ok(
    buildMs <= MAX_COLD_BUILD_MS,
    `${source}: cold index build exceeds ${MAX_COLD_BUILD_MS}ms target`,
  );
  assert.ok(
    report.processPeakRssBytes <= MAX_PROCESS_PEAK_RSS_BYTES,
    `${source}: process peak RSS exceeds the default self-hosted API 2GiB limit`,
  );
  return report;
};
const sources = Object.values(SANCTIONS_SOURCES).filter(
  ({ id }) => values.source === undefined || values.source.includes(id),
);
assert.ok(
  sources.length > 0,
  "--source must name a supported sanctions source",
);
assert.ok(
  values.source === undefined ||
    values.source.every((source) => sources.some(({ id }) => id === source)),
  "--source must name a supported sanctions source",
);
for (const { id: source } of sources) {
  // This command is the external-I/O boundary; report every source failure so
  // one unavailable publisher cannot conceal the other editions' evidence.
  try {
    await proveEdition(source);
  } catch (error) {
    failures.push(source);
    let message = "UnknownError";
    if (error instanceof Error) {
      message = error.name;
    }
    if (error instanceof AssertionError) {
      message = error.message;
    }
    console.error(JSON.stringify({ source, status: "failed", error: message }));
  }
}
console.log(
  JSON.stringify({
    residentIndexes: residentIndexes.length,
    rssBytes: process.memoryUsage().rss,
  }),
);
assert.equal(
  failures.length,
  0,
  `Publisher-edition proof failed: ${failures.join(", ")}`,
);
