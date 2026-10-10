import { panic } from "better-result";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
/**
 * What this adapter does with the record its publisher serves.
 *
 * The service publishes its own OpenAPI document, so the field list is not
 * something an implementer infers from a sample: it is declared, and the
 * first suite below diffs the inventory against it. A field the ministry adds
 * to `Rozhodnutie` therefore fails here by name, on the schema, rather than
 * waiting for someone to notice a value arriving on a response the crawl
 * already pays for and going nowhere — which is how `oblast`, `povodnySud`
 * and `povodnaSpisovaZnacka` were fetched and discarded for years.
 *
 * The rest drive a decision the crawl actually stored: the committed page
 * recording holds real records, so the assertions about where a field lands
 * are made against what the publisher sent rather than against a payload
 * written to match the code.
 */
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { StoredRawReparseOutcome } from "@/api/handlers/case-law/ingestion/adapter";
import { PublisherPageError } from "@/api/handlers/case-law/ingestion/adapters/publisher-page";
import { PUBLISHER_BODY_MAX_BYTES } from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import {
  assembleSkCourtsDecision,
  skCourtsAdapter,
  SK_COURTS_SOURCE_FIELD_PATHS,
} from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import {
  planUnreadItems,
  type UnavailableStreaks,
} from "@/api/handlers/case-law/ingestion/pipeline/unread-items";
import { toPlainTextMetadataObject } from "@/api/lib/case-law/plain-text";
import {
  isReadRefusal,
  isStoredReadAbsence,
  isStoredReadUnavailable,
  READ_OUTCOME_METADATA_KEY,
  type StoredReadOutcome,
  UNAVAILABLE_CYCLES_BEFORE_MARKING,
} from "@/api/lib/errors/read-outcome";
import { FetchBoundaryError } from "@/api/lib/errors/tagged-errors";
import { readGzipJson } from "@/api/lib/gzip-json";
import {
  type IngestionResult,
  toPlainTextIngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import { rehydrateMetadataUrls } from "@/api/lib/legal-search/metadata-urls";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { SK_COURTS_METADATA_URL_SCHEMA } from "./sk-courts.metadata-urls";

/**
 * The stored read-outcome marker, typed as the stored shape: metadata values
 * are branded plain text, so the narrowed metadata value cannot be compared
 * with a literal directly.
 */
const storedOutcome = (
  decision: IngestionResult | undefined,
): StoredReadOutcome => {
  const marker = decision?.metadata[READ_OUTCOME_METADATA_KEY];
  if (
    isReadRefusal(marker) ||
    isStoredReadAbsence(marker) ||
    isStoredReadUnavailable(marker)
  ) {
    return marker;
  }
  throw new Error("expected a stored read outcome");
};

/**
 * A body past the publisher read ceiling, streamed from one reused chunk so
 * the test holds a megabyte, not the ceiling.
 */
const oversizedBody = (): ReadableStream<Uint8Array> => {
  const chunk = new Uint8Array(1024 * 1024);
  let served = 0;
  return new ReadableStream({
    pull: (controller) => {
      if (served > PUBLISHER_BODY_MAX_BYTES) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      served += chunk.byteLength;
    },
  });
};

describe("Slovak court backfill rejects unreadable publisher listings", () => {
  afterEach(() => mock.restore());

  for (const body of [
    "<html><script src='/challenge.js'></script></html>",
    "{}",
    '{"rozhodnutieList":[]}',
    '{"numFound":0}',
    '{"rozhodnutieList":',
    "",
  ]) {
    test(`holds the page on ${JSON.stringify(body)}`, async () => {
      spyOn(globalThis, "fetch").mockImplementation(
        asFetchMock(async () => new Response(body)),
      );
      const page = await skCourtsAdapter.fetchPage(null, {});
      expect(page.isErr()).toBe(true);
      if (page.isErr()) {
        expect(page.error).toBeInstanceOf(PublisherPageError);
      }
    });
  }

  test("accepts an explicit small empty collection", async () => {
    spyOn(globalThis, "fetch").mockImplementation(
      asFetchMock(
        async () => new Response('{"rozhodnutieList":[],"numFound":0}'),
      ),
    );
    const page = await skCourtsAdapter.fetchPage(null, {});
    expect(page.isOk()).toBe(true);
    if (page.isOk()) {
      expect(page.value.decisions).toEqual([]);
    }
  });

  for (const cursor of ["backfill:0", "frontier:2020-05-13:0"]) {
    for (const malformed of [{ spisovaZnacka: 42 }, null, "invalid"]) {
      test(`isolates a malformed member ${JSON.stringify(malformed)} at ${cursor}`, async () => {
        const good = {
          guid: "23ea32af-a671-41a6-b853-72f5d52b820c:26b85db6-ff6b-44ff-8fa4-a21c89805371",
          spisovaZnacka: "7C/221/1991",
          sud: { nazov: "Okresný súd Bratislava I" },
          datumVydania: "14.05.2020",
        };
        spyOn(globalThis, "fetch").mockImplementation(
          asFetchMock(async (input: string | URL | Request) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            return Response.json(
              url.searchParams.has("page")
                ? {
                    rozhodnutieList: [
                      ...Array.from({ length: 99 }, () => good),
                      malformed,
                    ],
                    numFound: 200,
                  }
                : { ecli: "ECLI:SK:OSBA1:2020:1.C.1.2020" },
            );
          }),
        );
        const page = await skCourtsAdapter.fetchPage(cursor, {});
        expect(page.isOk()).toBe(true);
        if (page.isOk()) {
          expect(
            Bun.deepEquals(
              page.value.decisions.map(({ caseNumber }) => caseNumber),
              Array.from({ length: 99 }, () => good.spisovaZnacka),
            ),
          ).toBe(true);
          expect(page.value.itemBuildFailures).toEqual({
            type: "item_build_failed",
            count: 1,
          });
          expect(page.value.nextCursor).toBe(
            cursor.startsWith("backfill:")
              ? "backfill:100"
              : "frontier:2020-05-13:1",
          );
        }
      });
    }

    for (const [detail, outcome] of [
      [{}, "stated-absence"],
      [{ ecli: 42 }, "unreadable"],
    ] as const) {
      test(`a detail record served as ${JSON.stringify(detail)} at ${cursor} is a ${outcome}`, async () => {
        const good = {
          guid: "good-detail",
          spisovaZnacka: "1C/1/2020",
          sud: { nazov: "Okresný súd Bratislava I" },
          datumVydania: "14.05.2020",
        };
        const bad = { ...good, guid: "bad-detail", spisovaZnacka: "1C/2/2020" };
        spyOn(globalThis, "fetch").mockImplementation(
          asFetchMock(async (input: string | URL | Request) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.searchParams.has("page")) {
              return Response.json({
                rozhodnutieList: [
                  ...Array.from({ length: 99 }, () => good),
                  bad,
                ],
                numFound: 200,
              });
            }
            if (url.pathname.endsWith("/bad-detail")) {
              return Response.json(detail);
            }
            return Response.json({ ecli: "ECLI:SK:OSBA1:2020:1.C.1.2020" });
          }),
        );
        const page = await skCourtsAdapter.fetchPage(cursor, {});
        if (outcome === "unreadable") {
          // A record this adapter cannot read is an unread item, never a
          // page failure: the pipeline holds the page for a bounded number
          // of cycles, so one malformed record cannot pin the cursor.
          const { decisions, unreadItems } = page.unwrap();
          expect(
            Bun.deepEquals(
              decisions.map(({ caseNumber }) => caseNumber),
              Array.from({ length: 99 }, () => good.spisovaZnacka),
            ),
          ).toBe(true);
          expect(unreadItems).toHaveLength(1);
          const unread = unreadItems?.at(0);
          expect(unread?.listing.sourceDocumentId).toBe("bad-detail");
          expect(unread?.listing.caseNumber === bad.spisovaZnacka).toBe(true);
          expect(unread?.listing.isListingOnly).toBe(true);
          expect(unread?.outcome.type).toBe("unavailable");
          expect(
            unread?.outcome.type === "unavailable" &&
              unread.outcome.cause.kind === "thrown"
              ? unread.outcome.cause.error
              : undefined,
          ).toBeInstanceOf(FetchBoundaryError);
          return;
        }
        expect(page.isOk()).toBe(true);
        if (page.isOk()) {
          expect(
            Bun.deepEquals(
              page.value.decisions.map(({ caseNumber }) => caseNumber),
              [
                ...Array.from({ length: 99 }, () => good.spisovaZnacka),
                bad.spisovaZnacka,
              ],
            ),
          ).toBe(true);
          expect(page.value.itemBuildFailures).toEqual({
            type: "item_build_failed",
            count: 1,
          });
          // Only the row the service stated no record for is listing-only,
          // with the publisher's absence typed, so it never overwrites a
          // stored row's detail with absences.
          expect(
            page.value.decisions.map(({ isListingOnly }) => isListingOnly),
          ).toEqual([...Array.from({ length: 99 }, () => undefined), true]);
          expect(storedOutcome(page.value.decisions.at(-1))).toEqual({
            type: "absent",
            evidence: "publisher-typed-absence",
          });
          expect(page.value.nextCursor).toBe(
            cursor.startsWith("backfill:")
              ? "backfill:100"
              : "frontier:2020-05-13:1",
          );
        }
      });
    }
  }
});

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

// ── The publisher's own schema ───────────────────────────

/** The decision schema of the captured OpenAPI document, and its components. */
type SchemaComponents = Readonly<Record<string, unknown>>;

const schemaComponentsOf = (document: unknown): SchemaComponents => {
  const components = isRecord(document) ? document["components"] : undefined;
  const schemas = isRecord(components) ? components["schemas"] : undefined;
  return isRecord(schemas)
    ? schemas
    : panic("the captured OpenAPI document declares no component schemas");
};

/** A `$ref` followed to the component it names. */
const dereference = (node: unknown, schemas: SchemaComponents): unknown => {
  if (!isRecord(node)) {
    return node;
  }
  const reference = node["$ref"];
  if (typeof reference !== "string") {
    return node;
  }
  const name = reference.split("/").at(-1) ?? "";
  return (
    schemas[name] ?? panic(`the schema references an absent component: ${name}`)
  );
};

/**
 * Every property path one schema declares, spelled the way the adapter's
 * inventory spells them: an object contributes its leaves, and a list of
 * objects contributes `parent[].child`.
 */
const declaredPropertyPaths = (
  node: unknown,
  path: string,
  schemas: SchemaComponents,
): readonly string[] => {
  const resolved = dereference(node, schemas);
  if (!isRecord(resolved)) {
    return [path];
  }
  const properties = resolved["properties"];
  if (isRecord(properties)) {
    return Object.entries(properties).flatMap(([name, property]) =>
      declaredPropertyPaths(
        property,
        path === "" ? name : `${path}.${name}`,
        schemas,
      ),
    );
  }
  const items = resolved["items"];
  if (resolved["type"] === "array" && items !== undefined) {
    const element = dereference(items, schemas);
    return isRecord(element) && isRecord(element["properties"])
      ? declaredPropertyPaths(items, `${path}[]`, schemas)
      : [path];
  }
  return [path];
};

describe("the inventory is keyed on the schema the service publishes", () => {
  test("it decides about every path `Rozhodnutie` declares, and no other", async () => {
    const schemas = schemaComponentsOf(
      await readGzipJson(new URL("sk-courts-openapi.json.gz", FIXTURES_DIR)),
    );
    const declared = [
      ...declaredPropertyPaths(schemas["Rozhodnutie"], "", schemas),
    ].toSorted();
    const decided = [...SK_COURTS_SOURCE_FIELD_PATHS].toSorted();

    const undecided = declared.filter((path) => !decided.includes(path));
    const invented = decided.filter((path) => !declared.includes(path));

    expect(
      undecided,
      `the service declares these and the inventory decides nothing about them: ${undecided.join(", ")}.`,
    ).toEqual([]);
    expect(
      invented,
      `the inventory decides about these and the service declares no such path: ${invented.join(", ")}. Recapture the schema, or fix the spelling.`,
    ).toEqual([]);
  });

  test("the listing row's schema is a subset of the record's", async () => {
    const schemas = schemaComponentsOf(
      await readGzipJson(new URL("sk-courts-openapi.json.gz", FIXTURES_DIR)),
    );
    const listing = declaredPropertyPaths(
      schemas["BaseRozhodnutie"],
      "",
      schemas,
    );
    const record = declaredPropertyPaths(schemas["Rozhodnutie"], "", schemas);

    // Keying the inventory on the record alone is only total over both pages
    // because of this: a property the listing states and the record does not
    // would be a field nothing decided about.
    expect(listing.filter((path) => !record.includes(path))).toEqual([]);
  });
});

// ── A record the crawl stored ────────────────────────────

/**
 * The transferred-file decision of the committed page recording.
 *
 * Selected by the publisher's own id rather than by docket or position. The
 * docket would not do: this recording holds two decisions of one case under
 * `7C/221/1991`, six years and one ECLI ordinal apart, which is the same
 * reason the row is keyed on `guid` rather than on the number a court printed
 * on it.
 *
 * It is the row that states the legal area, the transferring court and the
 * docket that court opened the file under — the three the adapter used to
 * fetch and discard. It is also the row where the two responses disagree: the
 * listing carries the pre-transfer docket and court (`7C/221/1991`, `Okresný
 * súd Bratislava I`) and the record the post-transfer ones
 * (`B1-7C/221/1991`, `Mestský súd Bratislava IV`), so which response a field
 * is read from decides what the row says. The adapter keys on the listing,
 * because that is the response the crawl enumerates and reconciles against.
 */
const TRANSFERRED_FILE_ID =
  "23ea32af-a671-41a6-b853-72f5d52b820c:26b85db6-ff6b-44ff-8fa4-a21c89805371";

const TRANSFERRED_FILE_DOCKET = "7C/221/1991";

type StoredDecision = { sourceRaw: string; sourceRawContentType: string };

const storedDecision = async (
  sourceDocumentId: string,
): Promise<StoredDecision> => {
  const recording = await readGzipJson(
    new URL("sk-courts-page.json.gz", FIXTURES_DIR),
  );
  const page = isRecord(recording) ? recording["page"] : undefined;
  const decisions = isRecord(page) ? page["decisions"] : undefined;
  const found = isUnknownArray(decisions)
    ? decisions.find(
        (decision) =>
          isRecord(decision) &&
          decision["sourceDocumentId"] === sourceDocumentId,
      )
    : undefined;
  if (
    !isRecord(found) ||
    typeof found["sourceRaw"] !== "string" ||
    typeof found["sourceRawContentType"] !== "string"
  ) {
    return panic(`the page recording holds no decision ${sourceDocumentId}`);
  }
  return {
    sourceRaw: found["sourceRaw"],
    sourceRawContentType: found["sourceRawContentType"],
  };
};

const reparse = (
  stored: StoredDecision,
  caseNumber: string,
): StoredRawReparseOutcome => {
  const outcome = skCourtsAdapter.reparseStoredRaw?.({
    raw: new TextEncoder().encode(stored.sourceRaw),
    contentType: stored.sourceRawContentType,
    caseNumber,
    sourceDocumentId: null,
    language: "sk",
    court: "",
    ecli: null,
    decisionDate: null,
    decisionType: null,
    sourceUrl: null,
    documentUrl: null,
    metadata: {},
  });
  if (outcome === undefined) {
    return panic("sk-courts declares no reparseStoredRaw");
  }
  return outcome instanceof Promise
    ? panic("sk-courts reparseStoredRaw must answer without I/O")
    : outcome;
};

describe("a stored record reaches the targets the inventory declares", () => {
  test("the rows written before the envelope are still readable", async () => {
    const stored = await storedDecision(TRANSFERRED_FILE_ID);

    // The shape this adapter wrote for several million rows: one JSON object
    // wrapping the two responses under its own key names.
    expect(stored.sourceRawContentType).toBe("application/json");
    expect(decodeSourceRawEnvelope(stored.sourceRaw)).toBeNull();

    const outcome = reparse(stored, TRANSFERRED_FILE_DOCKET);

    expect(outcome.type).toBe("parsed");
  });

  test("the three fields the adapter used to discard land in metadata", async () => {
    const outcome = reparse(
      await storedDecision(TRANSFERRED_FILE_ID),
      TRANSFERRED_FILE_DOCKET,
    );
    if (outcome.type !== "parsed") {
      throw new Error(
        `the stored record did not re-parse: ${outcome.type === "rejected" ? outcome.detail : outcome.type}`,
      );
    }
    const { metadata } = outcome.result;

    expect(Bun.deepEquals(metadata["area"], ["Občianske právo"])).toBe(true);
    expect(metadata["originCourt"] === "Mestský súd Bratislava I").toBe(true);
    expect(metadata["originCourtRegistreGuid"] === "sud_102").toBe(true);
    // The docket the file was opened under, beside the prefixed one the
    // receiving court renumbered it to. A citation names the first, and
    // before this the row held neither the name nor the number.
    expect(metadata["originCaseNumber"] === "7C/221/1991").toBe(true);
    expect(outcome.result.caseNumber === TRANSFERRED_FILE_DOCKET).toBe(true);
  });

  test("the record's other labelled fields keep their targets", async () => {
    const outcome = reparse(
      await storedDecision(TRANSFERRED_FILE_ID),
      TRANSFERRED_FILE_DOCKET,
    );
    if (outcome.type !== "parsed") {
      throw new Error(
        `the stored record did not re-parse: ${outcome.type === "rejected" ? outcome.detail : outcome.type}`,
      );
    }
    const { metadata } = outcome.result;

    expect(outcome.result.ecli === "ECLI:SK:OSBA1:1997:1191896318.4").toBe(
      true,
    );
    expect(outcome.result.court === "Okresný súd Bratislava I").toBe(true);
    expect(outcome.result.decisionDate).toBe("1997-06-20");
    expect(outcome.result.decisionType === "Rozsudok").toBe(true);
    expect(metadata["decisionTypeKey"] === "rozsudok").toBe(true);
    expect(metadata["identifikacneCislo"] === "1191896318").toBe(true);
    expect(Bun.deepEquals(metadata["subArea"], ["Ostatné"])).toBe(true);
    expect(Bun.deepEquals(metadata["decisionNature"], ["Zmeňujúce"])).toBe(
      true,
    );
    expect(metadata["documentName"] === "Rozsudok_7C-221-1991.pdf").toBe(true);
    expect(metadata["documentExtension"] === "PDF").toBe(true);
    expect(metadata).toHaveProperty("documentSize", 95_553);
    expect(metadata["updateDate"] === "26.09.2023").toBe(true);
    expect(metadata["updateDateIso"] === "2023-09-26").toBe(true);
    // The name is the judge's or a senior court officer's and the record says
    // which nowhere, so it stays a stated name rather than a bench role.
    expect(metadata["judge"] === "JUDr. Anton Mihalovits").toBe(true);
    expect(outcome.result.judges).toBeUndefined();
  });

  test("re-parsing writes the envelope, whatever shape it read", async () => {
    const outcome = reparse(
      await storedDecision(TRANSFERRED_FILE_ID),
      TRANSFERRED_FILE_DOCKET,
    );
    if (outcome.type !== "parsed") {
      throw new Error(
        `the stored record did not re-parse: ${outcome.type === "rejected" ? outcome.detail : outcome.type}`,
      );
    }

    expect(outcome.result.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    const parts = decodeSourceRawEnvelope(outcome.result.sourceRaw ?? "");

    expect(Object.keys(parts ?? {}).toSorted()).toEqual(["detail", "listing"]);
  });

  test("a payload naming another decision is refused", async () => {
    const outcome = reparse(
      await storedDecision(TRANSFERRED_FILE_ID),
      "9C/1/2026",
    );

    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "identity-mismatch",
    });
  });

  test("a payload this adapter never wrote is refused, not guessed at", () => {
    const outcome = reparse(
      { sourceRaw: "<html></html>", sourceRawContentType: "text/html" },
      TRANSFERRED_FILE_DOCKET,
    );

    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "unsupported-content",
    });
  });
});

describe("the census and the registry agree about this adapter", () => {
  test("its recorded surfaces match a complete decision envelope", () => {
    const { surfaces } = skCourtsAdapter.sourceSurfaces;
    const recorded = Object.entries(surfaces).flatMap(([, disposition]) =>
      disposition.disposition === "stored" ? [disposition.part] : [],
    );

    const registry = {
      registreGuid: "sud_102",
      nazov: "Mestský súd Bratislava I",
      typSudu: "Mestský súd",
    };
    const item = {
      guid: "surface-inventory",
      spisovaZnacka: "7C/221/1991",
      sud: {
        registreGuid: registry.registreGuid,
        nazov: "Okresný súd Bratislava I",
      },
    };
    const decision = assembleSkCourtsDecision({
      item,
      detail: item,
      courtRegistry: { status: "available", record: registry },
    });
    if (decision === null) {
      panic("Complete surface fixture must build a decision");
    }
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(parts).not.toBeNull();
    expect(recorded.toSorted()).toEqual(Object.keys(parts ?? {}).toSorted());
  });

  test("the surfaces still on the backlog name why", () => {
    const { surfaces } = skCourtsAdapter.sourceSurfaces;
    const backlog = Object.entries(surfaces).flatMap(
      ([surface, disposition]) =>
        disposition.disposition === "backlog" ? [surface] : [],
    );

    expect(backlog.toSorted()).toEqual(["bulk-dump", "document"]);
    expect(skCourtsAdapter.key).toBe(ADAPTER_KEYS.SK_COURTS);
  });
});

describe("derived general-court metadata", () => {
  const item = {
    spisovaZnacka: "1C/1/2024",
    guid: "decision-id",
    sud: { nazov: "Okresný súd" },
  };

  test("unavailable detail has no public link or publisher URL absence assertion", () => {
    const decision = assembleSkCourtsDecision({ item, detail: null });
    expect(decision?.sourceUrl).toBeUndefined();
    expect(decision?.metadata["sourceUrlStatus"] === "detail-unavailable").toBe(
      true,
    );
    expect(decision?.textFields.headnote).toEqual({
      type: "absent",
      reason: "not_published",
    });
    expect(decision?.textFields.legalSentence).toEqual({
      type: "absent",
      reason: "not_published",
    });
  });

  test("stored listings without detail replay with unknown publisher URL availability", () => {
    const outcome = reparse(
      {
        sourceRaw: encodeSourceRawEnvelope({
          listing: JSON.stringify(item),
        }),
        sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      },
      item.spisovaZnacka,
    );
    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      panic("the stored listing must be reparsable without its detail");
    }
    expect(outcome.result.sourceUrl).toBeUndefined();
    expect(
      outcome.result.metadata["sourceUrlStatus"] === "detail-unavailable",
    ).toBe(true);
    expect(outcome.result.metadata["statedSourceUrl"]).toBeUndefined();
  });

  test("published documents remain the public link, independently of a listing guid", () => {
    const url = "https://obcan.justice.sk/content/public/decision.pdf";
    const decision = assembleSkCourtsDecision({
      item: { ...item, guid: null },
      detail: { dokument: { url } },
    });
    expect(decision?.sourceUrl).toBe(url);
    expect(decision?.metadata["sourceUrlStatus"] === "published").toBe(true);
  });

  test("calendar-invalid dates remain stated and carry a derived defect", () => {
    for (const updateDate of ["31.02.2024", "unknown", ""]) {
      const decision = assembleSkCourtsDecision({
        item,
        detail: { updateDate },
      });
      expect(decision?.metadata["updateDate"] === updateDate).toBe(true);
      expect(decision?.metadata["updateDateIso"]).toBeUndefined();
      expect(
        Bun.deepEquals(decision?.metadata["updateDateDefect"], {
          type: "invalid-publisher-date",
          value: updateDate,
        }),
      ).toBe(true);
    }
  });
});

test("rejected source links retain plain publisher-stated text", () => {
  for (const url of ["data:text/plain,blocked", "not a URL", "", "   "]) {
    const decision = assembleSkCourtsDecision({
      item: { spisovaZnacka: "1C/1/2024", sud: { nazov: "Okresný súd" } },
      detail: { dokument: { url } },
    });
    expect(decision?.sourceUrl).toBeUndefined();
    expect(decision?.metadata).toHaveProperty(
      "sourceUrlStatus",
      "rejected-url",
    );
    expect(decision?.metadata).toHaveProperty("statedSourceUrl", url.trim());
    expect(decision?.metadata["metadataUrlDiagnostics"]).toBeUndefined();
  }
});

test("a successful detail without a URL states publisher absence", () => {
  const decision = assembleSkCourtsDecision({
    item: { spisovaZnacka: "1C/1/2024", sud: { nazov: "Okresný súd" } },
    detail: {},
  });
  expect(
    decision?.metadata["sourceUrlStatus"] === "not-published-by-source",
  ).toBe(true);
});

describe("declared metadata URLs remain scalar across projection and reload", () => {
  for (const entry of [
    { input: null, expected: null },
    { input: "", empty: true },
    { input: "   ", empty: true },
    {
      input: "https://publisher.example/item?a=1&amp;b=2",
      expected: "https://publisher.example/item?a=1&amp;b=2",
    },
    {
      input: "https://publisher.example/item?a=1&amp;amp;b=2",
      expected: "https://publisher.example/item?a=1&amp;amp;b=2",
    },
    {
      input: "https://publisher.example/item?a=1&b=2",
      expected: "https://publisher.example/item?a=1&b=2",
    },
    {
      input: "  https://publisher.example/item?x=%26amp%3B  ",
      expected: "https://publisher.example/item?x=%26amp%3B",
    },
    { input: "/item?a=1&amp;b=2", reason: "invalid-url" },
    { input: "ftp://publisher.example/item", reason: "unsafe-protocol" },
    {
      input: '<a href="https://publisher.example/item">link</a>',
      reason: "invalid-url",
    },
  ]) {
    test(String(entry.input), async () => {
      const { input } = entry;
      const decision =
        assembleSkCourtsDecision({
          item: {
            spisovaZnacka: "1C/1/2024",
            guid: "decision-id",
            sud: { nazov: "Okresný súd" },
          },
          detail: {
            dokument: { url: input },
            odkazovanePredpisy: [{ nazov: "Zákon", url: input }],
          },
        }) ?? panic("URL regression payload built no decision");
      const repeated = toPlainTextIngestionResult(
        decision,
        SK_COURTS_METADATA_URL_SCHEMA,
      ).unwrap().metadata;
      const serializedMetadata = JSON.stringify(decision.metadata);
      const restored = toPlainTextMetadataObject(
        rehydrateMetadataUrls(
          JSON.parse(serializedMetadata),
          SK_COURTS_METADATA_URL_SCHEMA,
        ),
        SK_COURTS_METADATA_URL_SCHEMA,
      ).unwrap();
      const addresses = ["referencedLegislation[0].url"];
      for (const metadata of [decision.metadata, repeated, restored]) {
        for (const address of addresses) {
          if ("expected" in entry) {
            expect(metadata).toHaveProperty(address, entry.expected);
          } else {
            expect(metadata).not.toHaveProperty(address);
          }
        }
        if ("empty" in entry) {
          expect(metadata["metadataUrlDiagnostics"]).toBeUndefined();
        }
        if ("reason" in entry) {
          expect(metadata).toHaveProperty(
            "metadataUrlDiagnostics.entries",
            expect.arrayContaining(
              addresses.map((address) => ({ address, reason: entry.reason })),
            ),
          );
        }
      }
    });
  }
});

describe("Slovak detail refusals preserve listing-only decisions", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each([401, 403] as const)(
    "a detail HTTP %s keeps the listed decision with the typed refusal and advances the page",
    async (status) => {
      const stored = await storedDecision(TRANSFERRED_FILE_ID);
      const raw: unknown = JSON.parse(stored.sourceRaw);
      const listing = isRecord(raw) ? raw["listItem"] : undefined;
      if (!isRecord(listing)) {
        panic("the recorded decision has no listing item");
      }
      let detailRequests = 0;
      globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.searchParams.has("page")) {
          return Response.json({ rozhodnutieList: [listing], numFound: 1 });
        }
        if (url.pathname.includes("/v1/sud/")) {
          return new Response("registry unavailable", { status: 404 });
        }
        expect(
          decodeURIComponent(url.pathname).endsWith(`/${TRANSFERRED_FILE_ID}`),
        ).toBe(true);
        detailRequests += 1;
        return new Response("refused", { status });
      });

      const page = (await skCourtsAdapter.fetchPage(null, {})).unwrap();
      expect(detailRequests).toBe(1);
      expect(page.decisions).toHaveLength(1);
      const decision = page.decisions.at(0);
      expect(decision?.caseNumber === TRANSFERRED_FILE_DOCKET).toBe(true);
      const parts = decodeSourceRawEnvelope(decision?.sourceRaw ?? "");
      expect(parts?.["listing"]).toBe(JSON.stringify(listing));
      expect(parts?.["detail"]).toBeUndefined();
      expect(decision?.isListingOnly).toBe(true);
      expect(storedOutcome(decision)).toEqual({
        type: "refused",
        status,
        scope: "document",
        cause: { kind: "http-status", retryAfter: null },
      });
      expect(page.nextCursor).not.toBeNull();
    },
  );

  test.each([
    ["404", 404, "http-404"],
    ["410", 410, "http-410"],
  ] as const)(
    "a detail read answering %s keeps a listing-only row with the stated absence",
    async (_label, status, evidence) => {
      const stored = await storedDecision(TRANSFERRED_FILE_ID);
      const raw: unknown = JSON.parse(stored.sourceRaw);
      const listing = isRecord(raw) ? raw["listItem"] : undefined;
      if (!isRecord(listing)) {
        panic("the recorded decision has no listing item");
      }
      globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.searchParams.has("page")) {
          return Response.json({ rozhodnutieList: [listing], numFound: 1 });
        }
        if (url.pathname.includes("/v1/sud/")) {
          return new Response("registry unavailable", { status: 404 });
        }
        return await Promise.resolve(new Response("", { status }));
      });

      const page = (await skCourtsAdapter.fetchPage(null, {})).unwrap();
      expect(
        page.decisions.map((decision) => ({
          isListingOnly: decision.isListingOnly,
          outcome: storedOutcome(decision),
        })),
      ).toEqual([
        { isListingOnly: true, outcome: { type: "absent", evidence } },
      ]);

      const reconciliation = requireReconciliation(skCourtsAdapter);
      expect(reconciliation.heldRequiresDetail).toBe(true);
      expect(await reconciliation.buildDecision(listing)).toEqual({
        type: "detail-unavailable",
      });
    },
  );

  /** The recorded listing row, served as a one-item page, with `answer` for its record. */
  const serveRecordedListing = async (
    answer: () => Response,
  ): Promise<Record<string, unknown>> => {
    const stored = await storedDecision(TRANSFERRED_FILE_ID);
    const raw: unknown = JSON.parse(stored.sourceRaw);
    const listing = isRecord(raw) ? raw["listItem"] : undefined;
    if (!isRecord(listing)) {
      return panic("the recorded decision has no listing item");
    }
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.has("page")) {
        return Response.json({ rozhodnutieList: [listing], numFound: 1 });
      }
      if (url.pathname.includes("/v1/sud/")) {
        return new Response("registry unavailable", { status: 404 });
      }
      return await Promise.resolve(answer());
    });
    return listing;
  };

  test.each([
    ["500", () => new Response("", { status: 500 })],
    ["204", () => new Response(null, { status: 204 })],
    ["empty 200", () => new Response("")],
    ["malformed 200", () => Response.json({ ecli: 42 })],
    ["body over the read ceiling", () => new Response(oversizedBody())],
    [
      "timeout",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
  ] as const)(
    "a detail read answering %s is an unread item that holds the page for a bounded number of cycles",
    async (_label, answer) => {
      const listing = await serveRecordedListing(answer);

      let streaks: UnavailableStreaks = {};
      for (let cycle = 1; cycle <= UNAVAILABLE_CYCLES_BEFORE_MARKING; cycle++) {
        const page = (await skCourtsAdapter.fetchPage(null, {})).unwrap();
        expect(page.decisions).toEqual([]);
        expect(page.unreadItems).toHaveLength(1);
        const unread = page.unreadItems?.at(0);
        expect(unread?.listing.sourceDocumentId).toBe(TRANSFERRED_FILE_ID);
        expect(unread?.listing.isListingOnly).toBe(true);
        expect(unread?.outcome.type).toBe("unavailable");
        const parts = decodeSourceRawEnvelope(unread?.listing.sourceRaw ?? "");
        expect(parts?.["listing"]).toBe(JSON.stringify(listing));
        expect(parts?.["detail"]).toBeUndefined();

        const plan = planUnreadItems(page.unreadItems, streaks);
        if (cycle < UNAVAILABLE_CYCLES_BEFORE_MARKING) {
          expect(plan.holding).toBe(1);
          expect(plan.terminal).toEqual([]);
          streaks = plan.streaks;
          continue;
        }
        // The bound is spent: the listing is stored with the typed outcome
        // and the page advances.
        expect(plan.holding).toBe(0);
        expect(plan.streaks).toEqual({});
        expect(plan.terminal).toHaveLength(1);
        const terminal = plan.terminal.at(0);
        expect(terminal?.isListingOnly).toBe(true);
        expect(terminal?.sourceDocumentId).toBe(TRANSFERRED_FILE_ID);
        const outcome = storedOutcome(terminal);
        expect(outcome.type).toBe("unavailable");
        expect(
          outcome.type === "unavailable" ? outcome.consecutiveCycles : 0,
        ).toBe(UNAVAILABLE_CYCLES_BEFORE_MARKING);
      }

      const reconciliation = requireReconciliation(skCourtsAdapter);
      expect(reconciliation.heldRequiresDetail).toBe(true);
      expect(await reconciliation.buildDecision(listing)).toEqual({
        type: "detail-unavailable",
      });
    },
  );

  test("a detail body over the read ceiling is stored, once the bound is spent, with its typed cause", async () => {
    await serveRecordedListing(() => new Response(oversizedBody()));
    let streaks: UnavailableStreaks = {};
    for (let cycle = 1; cycle < UNAVAILABLE_CYCLES_BEFORE_MARKING; cycle++) {
      const page = (await skCourtsAdapter.fetchPage(null, {})).unwrap();
      streaks = planUnreadItems(page.unreadItems, streaks).streaks;
    }
    const page = (await skCourtsAdapter.fetchPage(null, {})).unwrap();
    const plan = planUnreadItems(page.unreadItems, streaks);
    expect(plan.terminal.map(storedOutcome)).toEqual([
      {
        type: "unavailable",
        scope: "document",
        cause: { kind: "too-large", maxBytes: PUBLISHER_BODY_MAX_BYTES },
        consecutiveCycles: UNAVAILABLE_CYCLES_BEFORE_MARKING,
      },
    ]);
  });

  test("a served-no-record detail is listing-only at once, never an unread item", async () => {
    await serveRecordedListing(() => Response.json({}));
    const page = (await skCourtsAdapter.fetchPage(null, {})).unwrap();
    expect(page.unreadItems).toBeUndefined();
    expect(page.decisions).toHaveLength(1);
    expect(page.decisions.at(0)?.isListingOnly).toBe(true);
    expect(storedOutcome(page.decisions.at(0))).toEqual({
      type: "absent",
      evidence: "publisher-typed-absence",
    });
  });

  test("a detail read answering 429 fails the page, so its cursor is kept", async () => {
    await serveRecordedListing(() => new Response("", { status: 429 }));
    const page = await skCourtsAdapter.fetchPage(null, {});
    expect(page.isErr()).toBe(true);
  });
});
