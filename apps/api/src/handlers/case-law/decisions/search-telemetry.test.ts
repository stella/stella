import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";

import {
  DECISION_QUERY_CLASS,
  decisionQueryClass,
  reportCaseLawSearchCompleted,
} from "@/api/handlers/case-law/decisions/search-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

/** The class the handler derives from the intent it already parsed. */
const classOf = (query: string) =>
  decisionQueryClass(parseDecisionQuery(query));

describe("what a search reports about the entry", () => {
  test("a docket and an ECLI are identifier entries", () => {
    expect(classOf("22 Cdo 2653/2012")).toBe(DECISION_QUERY_CLASS.identifier);
    expect(classOf("ECLI:EU:C:2014:317")).toBe(DECISION_QUERY_CLASS.identifier);
  });

  test("a quoted entry is a phrase, an unquoted one is terms", () => {
    expect(classOf('"náhrada škody"')).toBe(DECISION_QUERY_CLASS.phrase);
    expect(classOf("náhrada škody")).toBe(DECISION_QUERY_CLASS.term);
  });

  test("a phrase in the quotes the jurisdictions print is a phrase", () => {
    // The entry ran as a phrase against the engine, so it is recorded as one:
    // the class comes from the tokenizer, not from a search for ASCII quotes.
    expect(classOf("„náhrada škody“")).toBe(DECISION_QUERY_CLASS.phrase);
    expect(classOf("«náhrada škody»")).toBe(DECISION_QUERY_CLASS.phrase);
  });

  test("a quote that opens no span is terms, as it ran", () => {
    expect(classOf('"náhrada škody')).toBe(DECISION_QUERY_CLASS.term);
  });

  test("an entry the tokenizer finds nothing in is empty", () => {
    expect(classOf("   ")).toBe(DECISION_QUERY_CLASS.empty);
    // Punctuation only: no searchable token, and the handler answers with an
    // empty page rather than querying the engine.
    expect(classOf("!!! ???")).toBe(DECISION_QUERY_CLASS.empty);
  });
});

describe("the completed-search record", () => {
  let recording: RecordingLogger;

  beforeEach(() => {
    recording = installRecordingLogger();
  });

  afterEach(() => {
    recording.restore();
  });

  /** A first page: the facet read ran beside the scan and outlasted it. */
  const searchEvent = {
    candidatesHydrated: 42,
    country: "cz" as string | undefined,
    db: {
      reads: 6,
      msByRead: {
        alternates: 3.2,
        candidates: 8.4,
        courtWeights: 1.4,
        identity: 0,
        page: 4.6,
        servingGeneration: 0.8,
        sourceRegistry: 2.4,
      },
    },
    earlyStopped: true,
    facetMs: 96.3,
    hitsReturned: 20,
    indexMs: 88.6,
    pageRowsRead: 20,
    passagesScanned: 300,
    queryClass: classOf('"náhrada škody"'),
    roundCapHit: false,
    rounds: 1,
    highlightRounds: 1,
    scanAndFacetsMs: 97.1,
    totalMs: 130.2,
  };

  const emit = (event: Parameters<typeof reportCaseLawSearchCompleted>[0]) => {
    reportCaseLawSearchCompleted(event);
    const record = recording.records.at(0);
    if (record === undefined) {
      throw new Error("the search must emit exactly one record");
    }
    return record;
  };

  test("carries what the scan cost", () => {
    const record = emit(searchEvent);

    expect(record.severityText).toBe("INFO");
    expect(record.message).toBe("case_law.search.completed");
    expect(record.attributes).toEqual({
      queryClass: "phrase",
      country: "cz",
      rounds: 1,
      highlightRounds: 1,
      passagesScanned: 300,
      candidatesHydrated: 42,
      pageRowsRead: 20,
      hitsReturned: 20,
      indexMs: 89,
      facetMs: 96,
      scanAndFacetsMs: 97,
      dbReads: 6,
      dbMs: 20,
      dbAlternatesMs: 3,
      dbCandidatesMs: 8,
      dbCourtWeightsMs: 1,
      dbIdentityMs: 0,
      dbPageMs: 5,
      dbServingGenerationMs: 1,
      dbSourceRegistryMs: 2,
      totalMs: 130,
      roundCapHit: false,
      earlyStopped: true,
    });
    expect(recording.records).toHaveLength(1);
  });

  test("the database total is what its breakdown adds up to", () => {
    const attributes = emit(searchEvent).attributes ?? {};

    const parts = Object.entries(attributes).filter(
      ([key]) => key.startsWith("db") && key.endsWith("Ms") && key !== "dbMs",
    );
    // A read that grows has to show up in one of these, and a read nobody
    // named would make the two disagree.
    expect(parts).toHaveLength(7);
    const breakdown = parts.reduce((total, [, ms]) => total + Number(ms), 0);
    expect(Number(attributes["dbMs"])).toBe(breakdown);
  });

  test("carries no entry text and nothing the sanitizer had to drop", () => {
    const record = emit(searchEvent);

    // The class is all the record knows about the entry, and a dropped
    // attribute would mean a key the record should never have carried.
    for (const value of Object.values(record.attributes ?? {})) {
      expect(String(value)).not.toContain("náhrada");
    }
    expect(record.attributes).not.toHaveProperty("log.attributes_dropped");
  });

  test("omits the country an unscoped search does not have", () => {
    const record = emit({ ...searchEvent, country: undefined });

    expect(record.attributes).not.toHaveProperty("country");
  });

  test("the reader waits on the slower of the two concurrent reads", () => {
    const attributes = emit(searchEvent).attributes ?? {};

    // Neither their sum nor the faster arm: a request that added them would
    // charge the reader 185 ms of a 130 ms request, which is the misreading
    // the pair exists to prevent.
    const engineArms =
      Number(attributes["indexMs"]) + Number(attributes["facetMs"]);
    expect(engineArms).toBeGreaterThan(Number(attributes["totalMs"]));
    expect(Number(attributes["scanAndFacetsMs"])).toBeGreaterThanOrEqual(
      Math.max(Number(attributes["indexMs"]), Number(attributes["facetMs"])),
    );
    expect(Number(attributes["scanAndFacetsMs"])).toBeLessThan(engineArms);
  });

  test("a page that asked for no facets is charged none", () => {
    // A cursor page: the facet read never runs, so its own time is zero and
    // the registry read it would have made is absent from the breakdown too.
    const record = emit({
      ...searchEvent,
      db: {
        reads: 5,
        msByRead: { ...searchEvent.db.msByRead, sourceRegistry: 0 },
      },
      facetMs: 0,
      scanAndFacetsMs: 89.4,
    });
    const attributes = record.attributes ?? {};

    expect(attributes["facetMs"]).toBe(0);
    expect(attributes["dbSourceRegistryMs"]).toBe(0);
    expect(attributes["scanAndFacetsMs"]).toBe(89);
    expect(Number(attributes["scanAndFacetsMs"])).toBeGreaterThanOrEqual(
      Number(attributes["indexMs"]),
    );
  });
});
