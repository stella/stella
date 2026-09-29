/**
 * pl-nsa against rows the dataset serves.
 *
 * `pl-nsa-rows.json` holds 28 recorded rows chosen to cover every column and
 * the shapes that matter: each court tier, the pre-2004 NSA and its branch
 * seats, a seven-judge resolution, rows without reasons, without finality,
 * without judges. `pl-nsa-rows.parquet` is the same rows under the dataset's
 * own schema, which is what the reader and the cursor are driven over.
 */

import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parquetMetadataAsync, parquetSchema } from "hyparquet";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  assemblePlNsaDecision,
  composePlNsaFullText,
  createPlNsaCrawler,
  encodePlNsaCursor,
  normalizePlNsaRow,
  parsePlNsaCursor,
  plNsaAdapter,
  plNsaCourt,
  plNsaDecisionKind,
  plNsaDocket,
  plNsaDocketRangeMembers,
  plNsaIdentityOf,
  plNsaQuarantineId,
  PL_NSA_UNSTATED_COURT,
} from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import type { PlNsaDecisionKind } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import {
  huggingFaceShardSource,
  isPermanentPlNsaError,
  localFileShardSource,
  PL_NSA_FINGERPRINT_COLUMNS,
  PL_NSA_SNAPSHOT,
  plNsaSnapshotRows,
  readPlNsaListing,
  readPlNsaRows,
} from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import type {
  PlNsaDatasetRow,
  PlNsaShardSource,
  PlNsaSnapshot,
} from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import {
  decisionIdentifiersFromMetadata,
  normalizeDecisionIdentifier,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { parsePlNsaDecision } from "@/api/handlers/case-law/ingestion/parsers/pl-nsa";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);
const ROWS_JSON = new URL("pl-nsa-rows.json", FIXTURES_DIR);
const ROWS_PARQUET = new URL("pl-nsa-rows.parquet", FIXTURES_DIR).pathname;

type RecordedRow = {
  case: string;
  shard: number;
  row: number;
  values: PlNsaDatasetRow;
};

const recordedRows = async (): Promise<RecordedRow[]> => {
  const parsed: unknown = await Bun.file(ROWS_JSON).json();
  if (!Array.isArray(parsed)) {
    return panic("pl-nsa-rows.json holds no rows");
  }
  return parsed.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry["case"] !== "string" ||
      typeof entry["shard"] !== "number" ||
      typeof entry["row"] !== "number" ||
      !isRecord(entry["values"])
    ) {
      return panic("pl-nsa-rows.json holds a malformed row");
    }
    return {
      case: entry["case"],
      shard: entry["shard"],
      row: entry["row"],
      values: entry["values"],
    };
  });
};

const build = (recorded: RecordedRow): IngestionResult => {
  const shard =
    PL_NSA_SNAPSHOT.shards[recorded.shard] ?? panic("no such shard");
  const built = assemblePlNsaDecision({
    source: recorded.values,
    position: { shard, row: recorded.row },
    snapshot: PL_NSA_SNAPSHOT,
  });
  return built.decision;
};

const byCase = async (name: string): Promise<IngestionResult> => {
  const recorded = (await recordedRows()).find((row) => row.case === name);
  return build(recorded ?? panic(`no recorded row ${name}`));
};

const blocksOf = (decision: IngestionResult) =>
  "blocks" in decision.documentAst ? decision.documentAst.blocks : [];

const headingsOf = (decision: IngestionResult): string[] =>
  blocksOf(decision).flatMap((block) =>
    block.type === "heading" && block.role === "section-heading"
      ? [block.plainText]
      : [],
  );

/** Two shards backed by the recorded file, so a walk crosses a boundary. */
const fixtureSnapshot = (rows: number): PlNsaSnapshot => ({
  repository: PL_NSA_SNAPSHOT.repository,
  revision: PL_NSA_SNAPSHOT.revision,
  snapshotDate: PL_NSA_SNAPSHOT.snapshotDate,
  shards: [0, 1].map((index) => ({
    index,
    path: `data/data_${index}.parquet`,
    bytes: Bun.file(ROWS_PARQUET).size,
    sha256: "",
    rows,
  })),
});

/** The address a mocked request was made to, whatever form it came in. */
const requestUrlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

const firstShard = () => PL_NSA_SNAPSHOT.shards[0] ?? panic("no shard");

type Walk = { ids: string[]; hashes: string[]; cursors: string[] };

const walk = async (
  source: PlNsaShardSource,
  snapshot: PlNsaSnapshot,
  from: string | null,
): Promise<Walk> => {
  const crawler = createPlNsaCrawler({
    snapshot,
    source,
    windowRows: 10,
    pageRows: 4,
  });
  const result: Walk = { ids: [], hashes: [], cursors: [] };
  let cursor = from;
  for (let step = 0; step < 100; step += 1) {
    const page = (await crawler.fetchPage(cursor)).unwrap();
    result.ids.push(...page.decisions.map((d) => d.sourceDocumentId ?? ""));
    result.hashes.push(...page.decisions.map((d) => d.rawHash));
    if (page.nextCursor === cursor) {
      return result;
    }
    result.cursors.push(page.nextCursor ?? "null");
    cursor = page.nextCursor;
  }
  return panic("the walk did not park");
};

/** What a recorded row is expected to be classified as; unset is unchecked. */
type ExpectedClassification = {
  court?: string;
  level?: string;
  seat?: string;
  type?: string;
  bench?: string;
  era?: string;
  branch?: string;
  finality?: string;
};

describe("the recorded dataset rows", () => {
  test("every row builds, keyed by the portal's own document id", async () => {
    const rows = await recordedRows();
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const recorded of rows) {
      const decision = build(recorded);
      const id = String(recorded.values["judgment_id"]).replace("/doc/", "");
      expect(decision.sourceDocumentId).toBe(id);
      expect(decision.sourceUrl).toBe(
        `https://orzeczenia.nsa.gov.pl/doc/${id}`,
      );
      expect(decision.country).toBe("POL");
      expect(decision.language).toBe("pl");
      expect(decision.decisionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(decision.metadata["dataset"]).toMatchObject({
        repository: "JuDDGES/pl-nsa",
        revision: PL_NSA_SNAPSHOT.revision,
        snapshotDate: "2025-03-06",
        shard: `data/data_${recorded.shard}.parquet`,
        row: recorded.row,
      });
    }
  });

  test("the decision date is the Warsaw day, not the UTC one", async () => {
    // Stored as 2025-01-13T23:00:00Z, which is midnight on the 14th in Warsaw.
    const decision = await byCase("nsa-2025-reasons");
    expect(decision.decisionDate).toBe("2025-01-14");
    expect(decision.metadata["filedDate"]).toBe("2022-05-10");
  });

  test.each<[string, ExpectedClassification]>([
    [
      "wsa-thesis-official-collection",
      {
        court: "Wojewódzki Sąd Administracyjny w Opolu",
        level: "regional-administrative",
        seat: "Op",
        type: "wyrok",
        finality: "final",
      },
    ],
    [
      "wsa-gorzow",
      {
        court: "Wojewódzki Sąd Administracyjny w Gorzowie Wielkopolskim",
        level: "regional-administrative",
        seat: "Go",
        type: "wyrok",
      },
    ],
    [
      "wsa-warszawa-not-final",
      {
        court: "Wojewódzki Sąd Administracyjny w Warszawie",
        seat: "Wa",
        type: "postanowienie",
        finality: "not-final",
      },
    ],
    [
      "wsa-postanowienie-no-finality",
      { type: "postanowienie", finality: "not-stated" },
    ],
    [
      "nsa-wyrok-fsk-reasons",
      {
        court: "Naczelny Sąd Administracyjny",
        level: "supreme-administrative",
        type: "wyrok",
      },
    ],
    [
      "nsa-uchwala-seven-judges",
      {
        court: "Naczelny Sąd Administracyjny",
        type: "uchwała",
        bench: "seven-judges",
        era: "pre-2004",
      },
    ],
    [
      "pre-reform-warsaw",
      { court: "Naczelny Sąd Administracyjny", era: "pre-2004", type: "wyrok" },
    ],
    [
      "pre-reform-branch",
      {
        court: "Naczelny Sąd Administracyjny",
        era: "pre-2004",
        branch: "Ośrodek Zamiejscowy w Szczecinie",
      },
    ],
    [
      "nsa-postanowienie-s-label",
      { court: "Naczelny Sąd Administracyjny", type: "postanowienie" },
    ],
  ])("%s is classified by court, tier and kind", async (name, expected) => {
    const decision = await byCase(name);
    const { metadata } = decision;
    if (expected.court !== undefined) {
      expect(decision.court).toBe(expected.court);
    }
    if (expected.level !== undefined) {
      expect(metadata["courtLevel"]).toBe(expected.level);
    }
    if (expected.seat !== undefined) {
      expect(metadata["courtSeat"]).toBe(expected.seat);
    }
    if (expected.type !== undefined) {
      expect(decision.decisionType).toBe(expected.type);
    }
    if (expected.bench !== undefined) {
      expect(metadata["bench"]).toBe(expected.bench);
    }
    if (expected.era !== undefined) {
      expect(metadata["courtEra"]).toBe(expected.era);
    }
    if (expected.branch !== undefined) {
      expect(metadata["courtBranch"]).toBe(expected.branch);
    }
    if (expected.finality !== undefined) {
      expect(metadata["finality"]).toMatchObject({
        status: expected.finality,
        asOf: "2025-03-06",
      });
    }
  });

  test("a seat in the docket agrees with the court the row names", async () => {
    for (const recorded of await recordedRows()) {
      const decision = build(recorded);
      const seat = decision.metadata["courtSeat"];
      if (typeof seat === "string") {
        expect(decision.caseNumber).toContain(`/${seat} `);
      }
    }
  });

  test("modern dockets are read by the administrative docket grammar", async () => {
    for (const name of [
      "nsa-wyrok-fsk-reasons",
      "nsa-wyrok-osk-reasons",
      "nsa-postanowienie-oz",
      "wsa-gorzow",
      "nsa-2025-reasons",
    ]) {
      expect((await byCase(name)).metadata["docketRecognised"]).toBe(true);
    }
  });

  test("a judgment without reasons is stored whole, the reasons marked absent", async () => {
    const decision = await byCase("wsa-wyrok-no-reasons");
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.metadata["textSections"]).toEqual({
      thesis: "absent",
      sentence: "present",
      reasons: "absent",
      dissent: "absent",
    });
    expect(headingsOf(decision)).toEqual(["Sentencja"]);
    expect(decision.sections?.map((section) => section.type)).toEqual([
      "ruling",
    ]);
    expect(decision.fulltext).toContain("Sentencja");
  });

  test("a thesis-only row is its thesis, stored as the headnote", async () => {
    const decision = await byCase("pre-reform-branch-thesis-only");
    expect(headingsOf(decision)).toEqual(["Tezy"]);
    expect(decision.textFields.headnote.type).toBe("present");
    expect(decision.metadata["textSections"]).toMatchObject({
      thesis: "present",
      sentence: "absent",
      reasons: "absent",
    });
    const roles = blocksOf(decision).flatMap((block) =>
      block.type === "paragraph" ? [block.role] : [],
    );
    expect(new Set(roles)).toEqual(new Set(["headnotes"]));
  });

  test("sections keep the court's order and roles", async () => {
    const decision = await byCase("nsa-wyrok-thesis-collection");
    expect(headingsOf(decision)).toEqual(["Tezy", "Sentencja", "Uzasadnienie"]);
    const roles = new Set(
      blocksOf(decision).flatMap((block) =>
        block.type === "paragraph" ? [block.role] : [],
      ),
    );
    expect(roles).toEqual(new Set(["headnotes", "holding", "argumentation"]));
  });

  test("judges keep their roles and the bench as printed", async () => {
    const decision = await byCase("nsa-2025-reasons");
    expect(decision.judges).toEqual([
      { role: "presiding", nameAsPrinted: "Maciej Jaśniewicz" },
      { role: "rapporteur", nameAsPrinted: "Antoni Hanusz" },
      { role: "panel-member", nameAsPrinted: "Alicja Polańska" },
      { role: "panel-member", nameAsPrinted: "Antoni Hanusz" },
      { role: "panel-member", nameAsPrinted: "Maciej Jaśniewicz" },
    ]);
    // A row naming no judge says nothing about the bench, rather than that
    // there was none.
    expect((await byCase("no-judges")).judges).toBeUndefined();
  });

  test("related decisions link the court's own pages", async () => {
    const decision = await byCase("multiple-related");
    const related = decision.metadata["relatedDecisions"];
    expect(Array.isArray(related) && related.length >= 2).toBe(true);
    for (const item of Array.isArray(related) ? related : []) {
      expect(item).toMatchObject({
        documentId: expect.stringMatching(/^[0-9A-F]{10}$/u),
        sourceUrl: expect.stringMatching(
          /^https:\/\/orzeczenia\.nsa\.gov\.pl\/doc\/[0-9A-F]{10}$/u,
        ),
      });
    }
  });

  test("case symbols split into code and description", async () => {
    const decision = await byCase("case-symbol-without-description");
    const symbols = decision.metadata["caseSymbols"];
    expect(symbols).toContainEqual({
      code: expect.stringMatching(/^\d{3,4}$/u),
      description: null,
      asPublished: expect.stringMatching(/^\d{3,4}$/u),
    });
  });

  test("the stored row is the source row, verbatim", async () => {
    for (const recorded of await recordedRows()) {
      const row = normalizePlNsaRow(recorded.values);
      expect(composePlNsaFullText(row)).toBe(row.full_text ?? "");
      const parts = decodeSourceRawEnvelope(build(recorded).sourceRaw ?? "");
      const stored: unknown = JSON.parse(parts?.["row"] ?? "{}");
      // Every column, in the source's order, with the source's values —
      // the full text included, though the sections restate it.
      expect(stored).toEqual(recorded.values);
      expect(Object.keys(isRecord(stored) ? stored : {})).toEqual(
        Object.keys(recorded.values),
      );
    }
  });

  test("a row read from the file is stored as the file states it", async () => {
    const file = (
      await localFileShardSource(ROWS_PARQUET).local(firstShard())
    ).unwrap();
    const [row] = (
      await readPlNsaRows({ file, expectedRows: 28, rowStart: 0, rowEnd: 1 })
    ).unwrap();
    const built = assemblePlNsaDecision({
      source: row ?? panic("no row"),
      position: { shard: firstShard(), row: 0 },
      snapshot: PL_NSA_SNAPSHOT,
    });
    const decision = built.decision;
    const stored: unknown = JSON.parse(
      decodeSourceRawEnvelope(decision.sourceRaw ?? "")?.["row"] ?? "{}",
    );
    // The timestamp the file stores: milliseconds since the epoch, UTC.
    expect(isRecord(stored) ? stored["judgment_date"] : null).toBe(
      Date.parse("2005-10-12T22:00:00Z"),
    );
  });

  test("a stored row replays into the same decision", async () => {
    for (const recorded of await recordedRows()) {
      const decision = build(recorded);
      const replayed = await plNsaAdapter.reparseStoredRaw?.({
        raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
        contentType: decision.sourceRawContentType ?? null,
        caseNumber: decision.caseNumber,
        sourceDocumentId: decision.sourceDocumentId ?? null,
        language: decision.language,
        court: decision.court,
        ecli: null,
        decisionDate: decision.decisionDate ?? null,
        decisionType: decision.decisionType ?? null,
        sourceUrl: decision.sourceUrl ?? null,
        documentUrl: null,
        metadata: decision.metadata,
      });
      expect(replayed?.type).toBe("parsed");
      if (replayed?.type === "parsed") {
        expect(replayed.result.rawHash).toBe(decision.rawHash);
        expect(replayed.result.metadata).toEqual(decision.metadata);
        expect(replayed.result.fulltext).toBe(decision.fulltext);
      }
    }
  });
});

describe("every column the source states lands somewhere", () => {
  test("the recorded file's schema is covered by the inventory", async () => {
    const buffer = await Bun.file(ROWS_PARQUET).arrayBuffer();
    const metadata = await parquetMetadataAsync(buffer);
    const tree = parquetSchema(metadata);
    const fields: string[] = [];
    for (const column of tree.children) {
      const name = column.element.name;
      fields.push(name);
      // A list of structs: list -> element -> the struct's fields.
      const struct = column.children[0]?.children[0];
      for (const field of struct?.children ?? []) {
        fields.push(`${name}.${field.element.name}`);
      }
    }
    const declared = new Set(Object.keys(plNsaAdapter.sourceFields.fields));
    expect(fields.filter((field) => !declared.has(field))).toEqual([]);
    expect([...declared].filter((field) => !fields.includes(field))).toEqual(
      [],
    );
  });

  test("a column the dataset adds is kept and reported, not dropped", async () => {
    const [recorded] = await recordedRows();
    const shard = PL_NSA_SNAPSHOT.shards[0] ?? panic("no shard");
    const built = assemblePlNsaDecision({
      source: {
        ...(recorded ?? panic("no rows")).values,
        ecli: "ECLI:PL:NSA:2005:0001",
      },
      position: { shard, row: 0 },
      snapshot: PL_NSA_SNAPSHOT,
    });
    const decision = built.decision;
    const parts =
      decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? panic("no envelope");
    const stated = await plNsaAdapter.sourceFields.listSourceFields(parts);
    const undeclared = stated.filter(
      (field) => plNsaAdapter.sourceFields.fields[field] === undefined,
    );
    expect(undeclared).toEqual(["ecli"]);
    expect(JSON.parse(parts["row"] ?? "{}")).toMatchObject({
      ecli: "ECLI:PL:NSA:2005:0001",
    });
  });
});

describe("reading the parquet file", () => {
  test("rows read from the file build the same decisions as the recorded JSON", async () => {
    const recorded = await recordedRows();
    const buffer = (
      await localFileShardSource(ROWS_PARQUET).local(firstShard())
    ).unwrap();
    const rows = (
      await readPlNsaRows({
        file: buffer,
        expectedRows: 28,
        rowStart: 0,
        rowEnd: 99,
      })
    ).unwrap();
    expect(rows).toHaveLength(recorded.length);
    for (const [index, row] of rows.entries()) {
      const expected = recorded[index] ?? panic("row out of step");
      const shard =
        PL_NSA_SNAPSHOT.shards[expected.shard] ?? panic("no such shard");
      const built = assemblePlNsaDecision({
        source: row,
        position: { shard, row: expected.row },
        snapshot: PL_NSA_SNAPSHOT,
      });
      // The same decision; only the stored timestamps' spelling differs,
      // because each source is kept as it was served.
      const fromFile = built.decision;
      const fromJson = build(expected);
      expect(fromFile.metadata).toEqual(fromJson.metadata);
      expect(fromFile.fulltext).toBe(fromJson.fulltext);
      expect(fromFile.documentAst).toEqual(fromJson.documentAst);
    }
  });

  test("a window in the middle of the file skips to its rows", async () => {
    const buffer = (
      await localFileShardSource(ROWS_PARQUET).local(firstShard())
    ).unwrap();
    const recorded = await recordedRows();
    const rows = (
      await readPlNsaRows({
        file: buffer,
        expectedRows: 28,
        rowStart: 17,
        rowEnd: 20,
      })
    ).unwrap();
    expect(rows.map((row) => row["judgment_id"])).toEqual(
      recorded.slice(17, 20).map((row) => row.values["judgment_id"]),
    );
  });
});

describe("the cursor", () => {
  const snapshot = fixtureSnapshot(28);
  const source = localFileShardSource(ROWS_PARQUET);

  test("walks every row of every shard once, then parks", async () => {
    const recorded = await recordedRows();
    const ids = recorded.map((row) =>
      String(row.values["judgment_id"]).replace("/doc/", ""),
    );
    const full = await walk(source, snapshot, null);
    expect(full.ids).toEqual([...ids, ...ids]);
    expect(full.cursors.at(-1)).toBe(`${snapshot.revision}:2:0`);
  });

  test("a parked cursor reads nothing", async () => {
    const counted: PlNsaShardSource = {
      local: async (shard, signal) => await source.local(shard, signal),
      remote: async (shard, signal) => await source.remote(shard, signal),
    };
    const local = spyOn(counted, "local");
    const crawler = createPlNsaCrawler({ snapshot, source: counted });
    const parked = `${snapshot.revision}:2:0`;
    const page = (await crawler.fetchPage(parked)).unwrap();
    expect(page).toEqual({ decisions: [], nextCursor: parked });
    expect(local).not.toHaveBeenCalled();
  });

  test("resumes mid-shard where it stopped, across the shard boundary", async () => {
    const full = await walk(source, snapshot, null);
    // Row 13 of the first shard: inside the second window, off a page edge.
    const resumed = await walk(source, snapshot, `${snapshot.revision}:0:13`);
    expect(resumed.ids).toEqual(full.ids.slice(13));
    expect(resumed.hashes).toEqual(full.hashes.slice(13));
  });

  test("ids and hashes are stable across re-runs", async () => {
    const first = await walk(source, snapshot, null);
    const second = await walk(source, snapshot, null);
    expect(second.ids).toEqual(first.ids);
    expect(second.hashes).toEqual(first.hashes);
    expect(new Set(first.ids.slice(0, 28)).size).toBe(28);
  });

  test("a cursor from another revision starts this one from the beginning", () => {
    expect(
      parsePlNsaCursor(`${"0".repeat(40)}:12:500`, PL_NSA_SNAPSHOT),
    ).toEqual({ shard: 0, row: 0 });
    expect(
      parsePlNsaCursor(
        encodePlNsaCursor({ shard: 12, row: 500 }, PL_NSA_SNAPSHOT),
        PL_NSA_SNAPSHOT,
      ),
    ).toEqual({ shard: 12, row: 500 });
  });

  test("a reconciliation build passes its abort signal into the shard read", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const watched: PlNsaShardSource = {
      local: async (shard, signal) => {
        seen.push(signal);
        return await source.local(shard, signal);
      },
      remote: async (shard, signal) => await source.remote(shard, signal),
    };
    const crawler = createPlNsaCrawler({ snapshot, source: watched });
    const listed = await crawler.listSlicePage({ slice: "00", page: 0 });
    const item = listed.items[3] ?? panic("no item");
    const controller = new AbortController();
    await crawler.buildDecision(item.payload, controller.signal);
    expect(seen).toEqual([controller.signal]);
  });

  test("reconciliation lists a shard by id and builds what the crawl builds", async () => {
    const crawler = createPlNsaCrawler({ snapshot, source, windowRows: 10 });
    const listed = await crawler.listSlicePage({ slice: "01", page: 0 });
    expect(listed.totalPages).toBe(1);
    expect(listed.items).toHaveLength(28);
    const crawled = (
      await crawler.fetchPage(`${snapshot.revision}:1:5`)
    ).unwrap();
    const item = listed.items[5] ?? panic("no item");
    expect(item.identity).toEqual({
      type: "document",
      sourceDocumentId: crawled.decisions[0]?.sourceDocumentId ?? "",
    });
    const built = await crawler.buildDecision(item.payload);
    expect(built.type === "built" ? built.decision.rawHash : null).toBe(
      crawled.decisions[0]?.rawHash ?? "",
    );
    const moved = await crawler.buildDecision({
      ...(isRecord(item.payload) ? item.payload : {}),
      identity: "0000000000",
    });
    expect(moved.type).toBe("detail-unavailable");
  });
});

describe("dockets", () => {
  /** A recorded pre-2004 Warsaw judgment, re-docketed as the source prints some. */
  const withDocket = async (docket: string): Promise<IngestionResult> => {
    const recorded =
      (await recordedRows()).find((row) => row.case === "pre-reform-warsaw") ??
      panic("no recorded pre-2004 judgment");
    return build({
      ...recorded,
      values: { ...recorded.values, docket_number: docket },
    });
  };

  test("a joined docket names each of its cases as an identifier", async () => {
    const decision = await withDocket("I SA 1234-1236/98");
    expect(decision.caseNumber).toBe("I SA 1234-1236/98");
    expect(decision.metadata["docketRecognised"]).toBe(true);
    expect(decision.metadata["docketRangeMembers"]).toEqual([
      "I SA 1234/98",
      "I SA 1235/98",
      "I SA 1236/98",
    ]);
    // What the pipeline stores and resolves citations against: a citation
    // of the middle case keys the same as one of the row's identifiers.
    const stored = decisionIdentifiersFromMetadata({
      caseNumber: decision.caseNumber,
      identifiers: decision.identifiers,
      jurisdiction: decision.country,
    }).map((identifier) => normalizeDecisionIdentifier(identifier));
    expect(stored).toContain(
      normalizeDecisionIdentifier({
        type: "case-number",
        value: "I SA 1235/98",
      }),
    );
  });

  test("a seated joined docket expands under its seat", () => {
    const docket = plNsaDocket("SA/Bk 12-13/99") ?? panic("no docket");
    expect(plNsaDocketRangeMembers(docket)).toEqual([
      "SA/Bk 12/99",
      "SA/Bk 13/99",
    ]);
  });

  test("a descending, oversized or unrecognised range is not expanded", () => {
    for (const published of [
      "I SA 1236-1234/98",
      "I SA 1-500/98",
      "I XX 1-3/98",
    ]) {
      const docket = plNsaDocket(published) ?? panic("no docket");
      expect(plNsaDocketRangeMembers(docket)).toEqual([]);
    }
  });

  test("a single docket carries no extra identifiers", async () => {
    expect((await withDocket("II SA 2133/93")).identifiers).toBeUndefined();
  });

  test("a register lead is dropped from the case number, kept as published", async () => {
    const decision = await withDocket("12/II SA/Po 1234/99");
    expect(decision.caseNumber).toBe("II SA/Po 1234/99");
    expect(decision.metadata["docketAsPublished"]).toBe("12/II SA/Po 1234/99");
    expect(decision.metadata["docketRecognised"]).toBe(true);
  });

  test("an unrecognised docket is kept as printed and marked", async () => {
    // A register the grammar does not know, spaced as the source spaces it.
    const decision = await withDocket("SAO/Kr  12/82");
    expect(decision.caseNumber).toBe("SAO/Kr 12/82");
    expect(decision.metadata["docketRecognised"]).toBe(false);
  });
});

describe("the pinned revision", () => {
  test("states its size from the shards' own footers", async () => {
    expect(plNsaSnapshotRows(PL_NSA_SNAPSHOT)).toBe(2_254_392);
    const total = await plNsaAdapter.getTotalCount(
      new AbortController().signal,
    );
    expect(total).toEqual({ type: "count", total: 2_254_392 });
  });

  test("slices are the shards in order, the last one the tip", () => {
    const { reconciliation } = plNsaAdapter;
    expect(reconciliation.firstSlice).toBe("00");
    expect(reconciliation.sliceOf(new Date())).toBe("45");
    expect(reconciliation.nextSlice("09")).toBe("10");
    expect(reconciliation.nextSlice("45")).toBeNull();
    expect(reconciliation.previousSlice("00")).toBeNull();
  });
});

describe("court and kind vocabulary", () => {
  // Every court name the pinned revision states, with its row count.
  test.each([
    ["Naczelny Sąd Administracyjny", "Naczelny Sąd Administracyjny"],
    ["NSA w Warszawie (przed reformą)", "Naczelny Sąd Administracyjny"],
    ["NSA oz. we Wrocławiu", "Naczelny Sąd Administracyjny"],
    ["NSA oz. w Bydgoszczy", "Naczelny Sąd Administracyjny"],
    ["Sąd Najwyższy", "Sąd Najwyższy"],
    ["Trybunał Konstytucyjny", "Trybunał Konstytucyjny"],
    [
      "Wojewódzki Sąd Administracyjny w Białymstoku",
      "Wojewódzki Sąd Administracyjny w Białymstoku",
    ],
    [
      "Wojewódzki Sąd Administracyjny we Wrocławiu",
      "Wojewódzki Sąd Administracyjny we Wrocławiu",
    ],
  ])("%s is %s", (published, name) => {
    expect(plNsaCourt(published, null)?.name).toBe(name);
  });

  test("all sixteen regional courts are known by seat", () => {
    const seats = [
      "Białymstoku",
      "Bydgoszczy",
      "Gdańsku",
      "Gliwicach",
      "Gorzowie Wlkp.",
      "Kielcach",
      "Krakowie",
      "Lublinie",
      "Łodzi",
      "Olsztynie",
      "Opolu",
      "Poznaniu",
      "Rzeszowie",
      "Szczecinie",
      "Warszawie",
    ].map((seat) => `Wojewódzki Sąd Administracyjny w ${seat}`);
    seats.push("Wojewódzki Sąd Administracyjny we Wrocławiu");
    const courts = seats.map(
      (published) => plNsaCourt(published, null) ?? panic("no court"),
    );
    expect(new Set(courts.map((court) => court.seat)).size).toBe(16);
    expect(
      courts.every((court) => court.level === "regional-administrative"),
    ).toBe(true);
  });

  test.each<[string, string | undefined, PlNsaDecisionKind["bench"]]>([
    ["Wyrok WSA w Opolu", "wyrok", undefined],
    ["Postanowienie NSA", "postanowienie", undefined],
    ["Uchwała NSA", "uchwała", undefined],
    ["Uchwała Składu Pięciu Sędziów NSA", "uchwała", "five-judges"],
    ["Wyrok Składu Siedmiu Sędziów NSA", "wyrok", "seven-judges"],
    [
      "Uchwała Pełnego Składu Izby Cywilnej i Administracyjnej Sądu Najwyższego",
      "uchwała",
      "full-chamber",
    ],
    ["Uchwała Połączonych Izb Sądu Najwyższego", "uchwała", "joined-chambers"],
    ["Orzeczenie Trybunału Konstytucyjnego", "orzeczenie", undefined],
    ["NSA oz. w Lublinie", undefined, undefined],
  ])("%s is a %s with bench %s", (label, type, bench) => {
    expect(plNsaDecisionKind(label)).toEqual({ type, bench });
  });
});

describe("the adapter", () => {
  test("wraps a reader failure as the page's error", async () => {
    const result = await plNsaAdapter.fetchPage(
      `${PL_NSA_SNAPSHOT.revision}:0:0`,
      { cacheDirectory: "/dev/null/unwritable" },
    );
    expect(Result.isError(result)).toBe(true);
  });
});

describe("a row without a publisher id", () => {
  const withoutId = async (): Promise<PlNsaDatasetRow> => {
    const recorded =
      (await recordedRows()).find(
        (row) => row.case === "nsa-wyrok-fsk-reasons",
      ) ?? panic("no recorded row");
    return { ...recorded.values, judgment_id: null };
  };

  test("is quarantined under a fingerprint of what it does state, not dropped", async () => {
    const source = await withoutId();
    const built = assemblePlNsaDecision({
      source,
      position: { shard: firstShard(), row: 1 },
      snapshot: PL_NSA_SNAPSHOT,
    });
    const decision = built.decision;
    expect(decision.sourceDocumentId).toBe(plNsaQuarantineId(source));
    expect(decision.sourceDocumentId).toMatch(
      /^pl-nsa-quarantine:[0-9a-f]{64}$/u,
    );
    expect(decision.metadata["identityKind"]).toBe("quarantine");
    // No portal id, so no portal link.
    expect(decision.sourceUrl).toBeUndefined();
    // The verbatim row is what the quarantine holds.
    const stored: unknown = JSON.parse(
      decodeSourceRawEnvelope(decision.sourceRaw ?? "")?.["row"] ?? "{}",
    );
    expect(stored).toEqual(source);
  });

  test("a row that states its id carries the quarantine fingerprint as a repair alias", async () => {
    const recorded =
      (await recordedRows()).find(
        (row) => row.case === "nsa-wyrok-fsk-reasons",
      ) ?? panic("no recorded row");
    const identified = build(recorded);
    expect(identified.sourceDocumentIdRepairAliases).toEqual([
      plNsaQuarantineId(await withoutId()),
    ]);
  });

  test("the listing keys it the way the crawl stores it", async () => {
    const rows = (
      await readPlNsaRows({
        file: (
          await localFileShardSource(ROWS_PARQUET).local(firstShard())
        ).unwrap(),
        expectedRows: 28,
        rowStart: 0,
        rowEnd: 28,
      })
    ).unwrap();
    const listed = (
      await readPlNsaListing({
        file: (
          await localFileShardSource(ROWS_PARQUET).local(firstShard())
        ).unwrap(),
        expectedRows: 28,
        rowStart: 0,
        rowEnd: 28,
      })
    ).unwrap();
    // Ids present: no fingerprint read, keyed by the id.
    expect(listed.every(({ fingerprint }) => fingerprint === null)).toBe(true);
    // And the fingerprint the listing would build for a row equals the one
    // the crawl stores it under, whichever reader produced the values.
    for (const row of rows) {
      const fingerprintOnly = Object.fromEntries(
        PL_NSA_FINGERPRINT_COLUMNS.map((column) => [column, row[column]]),
      );
      expect(plNsaIdentityOf(fingerprintOnly).id).toBe(
        plNsaIdentityOf({ ...row, judgment_id: null }).id,
      );
    }
  });
});

describe("counts the source promises", () => {
  const source = localFileShardSource(ROWS_PARQUET);

  test("a footer stating other than the pinned row count is refused", async () => {
    const file = (await source.local(firstShard())).unwrap();
    const read = await readPlNsaRows({
      file,
      expectedRows: 29,
      rowStart: 0,
      rowEnd: 10,
    });
    expect(Result.isError(read)).toBe(true);
    if (Result.isError(read)) {
      expect(isPermanentPlNsaError(read.error)).toBe(true);
      expect(read.error.message).toContain("states 28 rows");
    }
  });

  test("a shard pinned at more rows than its file holds fails the page, not the rows", async () => {
    const crawler = createPlNsaCrawler({
      snapshot: fixtureSnapshot(30),
      source,
      windowRows: 10,
    });
    const page = await crawler.fetchPage(null);
    expect(Result.isError(page)).toBe(true);
  });

  test("a reconciliation listing over a short file rejects rather than listing fewer", async () => {
    const crawler = createPlNsaCrawler({
      snapshot: fixtureSnapshot(30),
      source,
    });
    const outcome = await crawler.listSlicePage({ slice: "00", page: 0 }).then(
      () => "listed",
      (error: unknown) => (error instanceof Error ? error.message : "rejected"),
    );
    expect(outcome).toContain("states 28 rows");
  });
});

describe("the deciding court comes from the record", () => {
  test.each([
    [
      "Wyrok WSA w Gorzowie Wlkp.",
      "Wojewódzki Sąd Administracyjny w Gorzowie Wielkopolskim",
    ],
    ["Postanowienie NSA", "Naczelny Sąd Administracyjny"],
    ["Wyrok NSA oz. we Wrocławiu", "Naczelny Sąd Administracyjny"],
    ["Uchwała Składu Siedmiu Sędziów Sądu Najwyższego", "Sąd Najwyższy"],
    ["Orzeczenie Trybunału Konstytucyjnego", "Trybunał Konstytucyjny"],
  ])("with no court name, %s names %s", (form, name) => {
    expect(plNsaCourt(null, form)).toMatchObject({
      name,
      statedBy: "decision-form",
    });
  });

  test("the Supreme Court and the Constitutional Tribunal keep their own names and ranks", () => {
    expect(plNsaCourt("Sąd Najwyższy", "Wyrok Sądu Najwyższego")).toMatchObject(
      { name: "Sąd Najwyższy", level: "supreme", statedBy: "court-name" },
    );
    expect(
      plNsaCourt("Trybunał Konstytucyjny", "Uchwała Trybunału Konstytucyjnego"),
    ).toMatchObject({
      name: "Trybunał Konstytucyjny",
      level: "constitutional",
    });
  });

  test("an unknown court name is kept as printed and marked, never defaulted", () => {
    const warn = spyOn(logger, "warn");
    expect(plNsaCourt("Sąd Wojskowy w Warszawie", "Wyrok NSA")).toEqual({
      name: "Sąd Wojskowy w Warszawie",
      level: "unrecognised",
      statedBy: "court-name",
    });
    expect(warn).toHaveBeenCalledWith(
      "case_law.ingestion.court_unrecognised",
      expect.objectContaining({ court: "Sąd Wojskowy w Warszawie" }),
    );
    warn.mockRestore();
  });

  test("a court name the decision form contradicts is reported; the name stands", () => {
    const warn = spyOn(logger, "warn");
    expect(
      plNsaCourt("Naczelny Sąd Administracyjny", "Wyrok WSA w Opolu")?.name,
    ).toBe("Naczelny Sąd Administracyjny");
    expect(warn).toHaveBeenCalledWith(
      "case_law.ingestion.court_conflict",
      expect.anything(),
    );
    warn.mockRestore();
  });

  test("a row naming no court anywhere is quarantined listing-only, never given a court", async () => {
    const recorded =
      (await recordedRows()).find(
        (row) => row.case === "nsa-wyrok-fsk-reasons",
      ) ?? panic("no recorded row");
    const source = {
      ...recorded.values,
      court_name: null,
      judgment_type: null,
    };
    const warn = spyOn(logger, "warn");
    const { decision } = assemblePlNsaDecision({
      source,
      position: { shard: firstShard(), row: 1 },
      snapshot: PL_NSA_SNAPSHOT,
    });
    // Stored, unpublished, under a label that is not a court.
    expect(decision.isListingOnly).toBe(true);
    expect(decision.court).toBe(PL_NSA_UNSTATED_COURT);
    expect(decision.metadata["quarantine"]).toEqual({
      reason: "court-unstated",
    });
    expect(decision.sourceDocumentId).toBe(
      String(recorded.values["judgment_id"]).replace("/doc/", ""),
    );
    // The verbatim row is kept for a repair to read.
    expect(
      JSON.parse(
        decodeSourceRawEnvelope(decision.sourceRaw ?? "")?.["row"] ?? "{}",
      ),
    ).toEqual(source);
    // Counted by reason.
    expect(warn).toHaveBeenCalledWith(
      "case_law.ingestion.row_quarantined",
      expect.objectContaining({ reason: "court-unstated" }),
    );
    warn.mockRestore();
  });
});

describe("the document is checked against the dataset's own text", () => {
  const input = {
    caseNumber: "II FSK 1/20",
    court: "Naczelny Sąd Administracyjny",
    decisionDate: "2020-01-01",
    decisionType: "wyrok",
    title: "Wyrok NSA",
    documentId: "0000000000",
    sourceUrl: "https://orzeczenia.nsa.gov.pl/doc/0000000000",
    keywords: [],
    statutes: [],
    sections: {
      thesis: null,
      sentence: "Naczelny Sąd Administracyjny oddala skargę kasacyjną.",
      reasons: null,
      dissent: null,
    },
  };

  test("text the sections carry passes", () => {
    const parsed = parsePlNsaDecision({
      ...input,
      reference:
        "SENTENCJA\n\nNaczelny Sąd Administracyjny oddala skargę kasacyjną.",
    });
    expect(parsed.validation.ok).toBe(true);
  });

  const REASONS =
    "Wojewódzki sąd rozpoznał skargę podatnika na interpretację indywidualną organu i uznał, że wnioskodawca prawidłowo ustalił przychód, a organ błędnie zastosował przepisy ustawy o podatku dochodowym od osób fizycznych w brzmieniu obowiązującym w dacie zdarzenia, co przesądziło o uchyleniu zaskarżonego aktu.";

  test("text only the full rendering carries is kept, from the rendering", () => {
    const error = spyOn(logger, "error");
    const parsed = parsePlNsaDecision({
      ...input,
      reference: [
        "SENTENCJA",
        "Naczelny Sąd Administracyjny oddala skargę kasacyjną.",
        "UZASADNIENIE",
        REASONS,
      ].join("\n\n"),
    });
    expect(parsed.textSource).toBe("full-text");
    expect(parsed.fulltext).toContain(REASONS);
    expect(parsed.validation.ok).toBe(true);
    expect(error).not.toHaveBeenCalledWith(
      "case_law.ingestion.ast_content_lost",
      expect.anything(),
    );
    error.mockRestore();
  });

  test("with every section empty, the rendering is the document", () => {
    const parsed = parsePlNsaDecision({
      ...input,
      sections: { thesis: null, sentence: null, reasons: null, dissent: null },
      reference: `UZASADNIENIE\n\n${REASONS}`,
    });
    expect(parsed.textSource).toBe("full-text");
    expect(parsed.fulltext).toContain(REASONS);
    expect(parsed.documentAst).not.toBeNull();
  });

  test("with no text anywhere, the check still runs and reports it", () => {
    const error = spyOn(logger, "error");
    const parsed = parsePlNsaDecision({
      ...input,
      sections: { thesis: null, sentence: null, reasons: null, dissent: null },
      reference: null,
    });
    expect(parsed.documentAst).toBeNull();
    expect(parsed.textSource).toBe("none");
    expect(parsed.validation.issues.length).toBeGreaterThan(0);
    error.mockRestore();
  });

  test("sections that hold everything are used as sections", () => {
    const parsed = parsePlNsaDecision({
      ...input,
      reference:
        "SENTENCJA\n\nNaczelny Sąd Administracyjny oddala skargę kasacyjną.",
    });
    expect(parsed.textSource).toBe("sections");
  });
});

describe("shard download failures", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;
  const bytes = new Uint8Array(Bun.file(ROWS_PARQUET).size);

  const shardOf = (sha256: string) => ({
    index: 0,
    path: "data/data_0.parquet",
    bytes: bytes.byteLength,
    sha256,
    rows: 28,
  });

  const snapshotOf = (sha256: string): PlNsaSnapshot => ({
    ...PL_NSA_SNAPSHOT,
    shards: [shardOf(sha256)],
  });

  /** Serves the recorded file the way the repository and its CDN do. */
  const serve = (
    answer: (range: string, url: string) => Response | null,
  ): { requests: string[] } => {
    const requests: string[] = [];
    let issued = 0;
    globalThis.fetch = asFetchMock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrlOf(input);
        expect(url).toMatch(/^https:\/\/[^/]*(huggingface\.co|hf\.co)\//u);
        const range = new Headers(init?.headers).get("range") ?? "";
        requests.push(`${init?.method ?? "GET"} ${range}`);
        if (init?.method === "HEAD") {
          // Each answer is a freshly signed address, as the CDN issues them.
          issued += 1;
          return await Promise.resolve(
            new Response(null, {
              status: 302,
              headers: {
                location: `https://cdn.hf.co/shard?signature=${issued}`,
              },
            }),
          );
        }
        const custom = answer(range, url);
        if (custom !== null) {
          return await Promise.resolve(custom);
        }
        const [start, end] = range.replace("bytes=", "").split("-").map(Number);
        return await Promise.resolve(
          new Response(bytes.slice(start, (end ?? 0) + 1), { status: 206 }),
        );
      },
    );
    return { requests };
  };

  let directory = "";
  beforeEach(async () => {
    bytes.set(new Uint8Array(await Bun.file(ROWS_PARQUET).arrayBuffer()));
    directory = await mkdtemp(nodePath.join(tmpdir(), "pl-nsa-download-"));
    Bun.sleep = async () => {
      // Retries back off against a live host; nothing here is live.
    };
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
    await rm(directory, { recursive: true, force: true });
  });

  const sha256 = (): string =>
    new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

  test("a verified download reads, and a verified file is not fetched twice", async () => {
    const { requests } = serve(() => null);
    const snapshot = snapshotOf(sha256());
    const source = huggingFaceShardSource({
      snapshot,
      cacheDirectory: directory,
    });
    const crawler = createPlNsaCrawler({ snapshot, source });
    const page = (await crawler.fetchPage(null)).unwrap();
    expect(page.decisions).toHaveLength(28);
    const before = requests.length;
    (await source.local(shardOf(sha256()))).unwrap();
    expect(requests.length).toBe(before);
  });

  test("a missing file is permanent: reported, remembered, not asked again", async () => {
    const { requests } = serve(() => new Response("gone", { status: 404 }));
    const snapshot = snapshotOf(sha256());
    const source = huggingFaceShardSource({
      snapshot,
      cacheDirectory: directory,
    });
    const first = await source.local(shardOf(sha256()));
    expect(Result.isError(first) && isPermanentPlNsaError(first.error)).toBe(
      true,
    );
    const asked = requests.length;
    const second = await source.local(shardOf(sha256()));
    expect(Result.isError(second)).toBe(true);
    expect(requests.length).toBe(asked);
  });

  test("bytes that do not hash to the revision's digest are removed and permanent", async () => {
    serve(() => null);
    const wrong = "0".repeat(64);
    const snapshot = snapshotOf(wrong);
    const source = huggingFaceShardSource({
      snapshot,
      cacheDirectory: directory,
    });
    const result = await source.local(shardOf(wrong));
    expect(Result.isError(result) && isPermanentPlNsaError(result.error)).toBe(
      true,
    );
    const left = await readdir(nodePath.join(directory, snapshot.revision));
    expect(left).toEqual([]);
  });

  test("a server error is transient: the page fails, the next attempt resumes", async () => {
    let failing = true;
    const { requests } = serve(() =>
      failing ? new Response("busy", { status: 503 }) : null,
    );
    const snapshot = snapshotOf(sha256());
    const source = huggingFaceShardSource({
      snapshot,
      cacheDirectory: directory,
    });
    const first = await source.local(shardOf(sha256()));
    expect(Result.isError(first)).toBe(true);
    if (Result.isError(first)) {
      expect(isPermanentPlNsaError(first.error)).toBe(false);
      expect(first.error.httpStatus).toBe(503);
    }
    failing = false;
    const asked = requests.length;
    (await source.local(shardOf(sha256()))).unwrap();
    expect(requests.length).toBeGreaterThan(asked);
  });

  test("a short read is transient and a later attempt completes", async () => {
    let short = true;
    serve((range) => {
      if (!short) {
        return null;
      }
      short = false;
      const [start] = range.replace("bytes=", "").split("-").map(Number);
      return new Response(bytes.slice(start, (start ?? 0) + 10), {
        status: 206,
      });
    });
    const snapshot = snapshotOf(sha256());
    const source = huggingFaceShardSource({
      snapshot,
      cacheDirectory: directory,
    });
    const first = await source.local(shardOf(sha256()));
    expect(Result.isError(first) && !isPermanentPlNsaError(first.error)).toBe(
      true,
    );
    (await source.local(shardOf(sha256()))).unwrap();
  });

  test("an expired signed address is re-resolved, not cached as a permanent failure", async () => {
    // The first address the repository hands out has expired by the time it
    // is read; a fresh one serves the bytes.
    const { requests } = serve((_, url) =>
      url.endsWith("signature=1")
        ? new Response("expired", { status: 403 })
        : null,
    );
    const snapshot = snapshotOf(sha256());
    const source = huggingFaceShardSource({
      snapshot,
      cacheDirectory: directory,
    });
    (await source.local(shardOf(sha256()))).unwrap();
    expect(
      requests.filter((request) => request.startsWith("HEAD")),
    ).toHaveLength(2);
  });

  test("a refusal of a freshly issued address is still permanent", async () => {
    serve(() => new Response("forbidden", { status: 403 }));
    const snapshot = snapshotOf(sha256());
    const source = huggingFaceShardSource({
      snapshot,
      cacheDirectory: directory,
    });
    const result = await source.local(shardOf(sha256()));
    expect(Result.isError(result) && isPermanentPlNsaError(result.error)).toBe(
      true,
    );
  });

  test("overlapping callers download a shard once, one after the other", async () => {
    const { requests } = serve(() => null);
    const snapshot = snapshotOf(sha256());
    const source = huggingFaceShardSource({
      snapshot,
      cacheDirectory: directory,
    });
    const [first, second] = await Promise.all([
      source.local(shardOf(sha256())),
      source.local(shardOf(sha256())),
    ]);
    expect(Result.isOk(first) && Result.isOk(second)).toBe(true);
    // One file of one chunk: one location, one ranged read.
    expect(
      requests.filter((request) => request.startsWith("GET")),
    ).toHaveLength(1);
  });
});

describe("overlapping window reads", () => {
  test("the crawler reads one window at a time", async () => {
    const snapshot = fixtureSnapshot(28);
    const file = localFileShardSource(ROWS_PARQUET);
    let inFlight = 0;
    let most = 0;
    const counting: PlNsaShardSource = {
      local: async (shard, signal) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await Bun.sleep(5);
        const result = await file.local(shard, signal);
        inFlight -= 1;
        return result;
      },
      remote: async (shard, signal) => await file.remote(shard, signal),
    };
    const crawler = createPlNsaCrawler({
      snapshot,
      source: counting,
      windowRows: 5,
    });
    const listed = await crawler.listSlicePage({ slice: "00", page: 0 });
    const payloads = [0, 7, 14, 21].map(
      (index) => (listed.items[index] ?? panic("no item")).payload,
    );
    const built = await Promise.all(
      payloads.map(async (payload) => await crawler.buildDecision(payload)),
    );
    expect(built.every((outcome) => outcome.type === "built")).toBe(true);
    expect(most).toBe(1);
  });
});

describe("unreadable timestamps", () => {
  const withDate = async (value: unknown) => {
    const recorded =
      (await recordedRows()).find(
        (row) => row.case === "nsa-wyrok-fsk-reasons",
      ) ?? panic("no recorded row");
    return assemblePlNsaDecision({
      source: { ...recorded.values, judgment_date: value },
      position: { shard: firstShard(), row: 1 },
      snapshot: PL_NSA_SNAPSHOT,
    }).decision;
  };

  test.each([
    ["an invalid date", new Date(Number.NaN)],
    ["a fractional count", 1.5],
    ["a count past any instant", 9e15],
    ["a nanosecond bigint", 1_700_000_000_000_000_000n],
    ["a malformed string", "not a date"],
  ])(
    "%s quarantines the row instead of stopping the crawl",
    async (_, value) => {
      const decision = await withDate(value);
      expect(decision.isListingOnly).toBe(true);
      expect(decision.metadata["quarantine"]).toEqual({
        reason: "timestamp-unreadable",
        fields: ["judgment_date"],
      });
    },
  );

  test("a readable timestamp is not quarantined", async () => {
    const decision = await withDate(new Date("2010-04-01T22:00:00Z"));
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.decisionDate).toBe("2010-04-02");
  });
});
