/**
 * Written reasons SAOS publishes apart from their ruling.
 *
 * Driven from the recorded dump page for 2018-03-22, which lists the
 * Wrocław regional court's appeal judgment `IV Ka 95/18` (id 339002) and its
 * reasons (id 339001) as two judgments, and seven more reasons documents
 * beside the day's rulings.
 */

import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionItem,
  StoredRawReparseInput,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildPlItem,
  normalizeSaosDumpItem,
  PL_COURTS_RULING_DECISION_TYPES,
  PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
  plCourtsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { DECISION_SUPPLEMENT_KIND } from "@/api/lib/legal-search/decision-supplement-kind";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const DUMP_PAGE = "pl-courts-dump-day.json.gz";
const RULING_ID = 339_002;
const REASONS_ID = 339_001;

const dumpPage = async (): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(DUMP_PAGE, FIXTURES)).bytes()),
  );

const listingRows = async (): Promise<Record<string, unknown>[]> => {
  const page: unknown = JSON.parse(await dumpPage());
  const items = isRecord(page) ? page["items"] : undefined;
  return isUnknownArray(items)
    ? items.filter(isRecord)
    : panic(`${DUMP_PAGE} holds no listing rows`);
};

const rowById = async (id: number): Promise<Record<string, unknown>> =>
  (await listingRows()).find((row) => row["id"] === id) ??
  panic(`${DUMP_PAGE} lists no judgment ${id}`);

const itemFrom = (row: Record<string, unknown>): IngestionItem =>
  buildPlItem({
    listingItem: normalizeSaosDumpItem(row),
    detail: null,
    rawParts: { "listing-dump": JSON.stringify(row) },
  }) ?? panic("the recorded row built nothing");

const upstreamIdOf = (row: Record<string, unknown>): string => {
  const source = row["source"];
  const judgmentId = isRecord(source) ? source["judgmentId"] : undefined;
  return typeof judgmentId === "string"
    ? judgmentId
    : panic("the row names no upstream id");
};

describe("SAOS reasons published apart from their ruling", () => {
  test("are a supplement keyed to the ruling's court and docket, not a decision", async () => {
    const reasonsRow = await rowById(REASONS_ID);
    const rulingRow = await rowById(RULING_ID);
    const reasons = itemFrom(reasonsRow);
    const ruling = itemFrom(rulingRow);

    expect(ruling.type).toBe("decision");
    expect(reasons.type).toBe("supplement");
    if (reasons.type !== "supplement" || ruling.type !== "decision") {
      return;
    }
    const { supplement } = reasons;
    expect(supplement.kind).toBe(DECISION_SUPPLEMENT_KIND.REASONS);
    expect(supplement.target).toEqual({
      decisionTypes: PL_COURTS_RULING_DECISION_TYPES,
      latestDecisionDate: "2018-03-22",
    });
    expect(supplement.document.sourceDocumentId).toBe(String(REASONS_ID));
    // Shared with the ruling: the key the judgment is found by.
    expect({
      court: supplement.document.court,
      caseNumber: supplement.document.caseNumber,
      language: supplement.document.language,
    }).toEqual({
      court: ruling.decision.court,
      caseNumber: ruling.decision.caseNumber,
      language: ruling.decision.language,
    });
    expect(ruling.decision.decisionType).toBe("wyrok");
    // A row holding the reasons alone says what it is.
    expect(supplement.document.decisionType).toBe(
      PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
    );
    expect(supplement.document.metadata["decisionType"]).toBe(
      PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
    );
    expect(supplement.document.fulltext ?? "").toContain("UZASADNIENIE");
    expect(
      Object.keys(
        decodeSourceRawEnvelope(supplement.document.sourceRaw ?? "") ?? {},
      ),
    ).toEqual(["listing-dump"]);
  });

  test("state no link to their ruling beyond the court's own document id", async () => {
    const reasonsRow = await rowById(REASONS_ID);
    const rulingRow = await rowById(RULING_ID);
    // No field of the reasons record names the ruling's SAOS id.
    expect(JSON.stringify(reasonsRow)).not.toContain(String(RULING_ID));
    // The deciding court's ids share everything up to the date and the
    // document's sequence number; that is the only structural join.
    const [reasonsId, rulingId] = [
      upstreamIdOf(reasonsRow),
      upstreamIdOf(rulingRow),
    ];
    const caseStem = (id: string) => id.split("_").slice(0, -2).join("_");
    expect(caseStem(reasonsId)).toBe(caseStem(rulingId));
    expect(reasonsId).not.toBe(rulingId);
  });

  test("every REASONS row of the page is a supplement and every other a decision", async () => {
    const rows = await listingRows();
    const reasonsIds = rows
      .filter((row) => row["judgmentType"] === "REASONS")
      .map((row) => String(row["id"]));
    expect(reasonsIds.length).toBeGreaterThan(0);

    const items = rows.map((row) =>
      buildPlItem({
        listingItem: normalizeSaosDumpItem(row),
        detail: null,
        rawParts: { "listing-dump": JSON.stringify(row) },
      }),
    );
    const supplementIds = items.flatMap((item) =>
      item?.type === "supplement"
        ? [item.supplement.document.sourceDocumentId]
        : [],
    );
    expect(supplementIds.toSorted()).toEqual(reasonsIds.toSorted());
    for (const item of items) {
      if (item?.type === "decision") {
        expect(item.decision.decisionType).not.toBe(
          PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
        );
      }
    }
  });
});

describe("a stored reasons row replays as a supplement", () => {
  const reparse =
    plCourtsAdapter.reparseStoredRaw ??
    panic("pl-courts declares no reparseStoredRaw");

  const storedInput = (
    row: Record<string, unknown>,
    caseNumber: string,
  ): StoredRawReparseInput => ({
    raw: new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        parts: { "listing-dump": JSON.stringify(row) },
      }),
    ),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    caseNumber,
    sourceDocumentId: String(row["id"]),
    language: "pl",
    court: "Sąd powszechny",
    ecli: null,
    decisionDate: "2018-03-22",
    decisionType: "uzasadnienie",
    sourceUrl: null,
    documentUrl: null,
    metadata: {},
  });

  test("the payload a pre-supplement row stored is read back as reasons", async () => {
    const outcome = await reparse(
      storedInput(await rowById(REASONS_ID), "IV Ka 95/18"),
    );
    expect(outcome.type).toBe("supplement");
    if (outcome.type === "supplement") {
      expect(outcome.supplement.document.sourceDocumentId).toBe(
        String(REASONS_ID),
      );
    }
  });

  test("the ruling's payload still replays as a decision", async () => {
    const outcome = await reparse(
      storedInput(await rowById(RULING_ID), "IV Ka 95/18"),
    );
    expect(outcome.type).toBe("parsed");
  });

  test("a reasons payload naming another docket is refused like any other", async () => {
    const outcome = await reparse(
      storedInput(await rowById(REASONS_ID), "IV Ka 999/18"),
    );
    expect(outcome.type).toBe("rejected");
  });
});

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

describe("the crawl and the reconciliation hand reasons over as supplements", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** The dump page lists the rows; a detail answers only for `details`. */
  const serve = (
    rows: readonly Record<string, unknown>[],
    details: readonly Record<string, unknown>[] = [],
  ) => {
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        const url = requestUrl(input);
        if (url.includes("/api/dump/judgments")) {
          return Response.json({ items: rows });
        }
        const detail = details.find((row) =>
          url.endsWith(`/api/judgments/${String(row["id"])}`),
        );
        return detail === undefined
          ? new Response("Not found", { status: 404 })
          : Response.json({ data: detail });
      },
      { preconnect: originalFetch.preconnect.bind(originalFetch) },
    );
  };

  test("a dump page carries the reasons apart from its decisions", async () => {
    const rows = [await rowById(REASONS_ID), await rowById(RULING_ID)];
    serve(rows);

    const page = (await plCourtsAdapter.fetchPage(null, {})).unwrap();

    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual([String(RULING_ID)]);
    expect(
      (page.supplements ?? []).map(
        ({ document: { sourceDocumentId } }) => sourceDocumentId,
      ),
    ).toEqual([String(REASONS_ID)]);
  });

  test("a listed reasons row builds a supplement", async () => {
    const reasonsRow = await rowById(REASONS_ID);
    serve([], [reasonsRow]);
    const built =
      await requireReconciliation(plCourtsAdapter).buildDecision(reasonsRow);
    expect(built.type).toBe("built-supplement");
    if (built.type === "built-supplement") {
      expect(
        Object.keys(
          decodeSourceRawEnvelope(built.supplement.document.sourceRaw ?? "") ??
            {},
        ).toSorted(),
      ).toEqual(["detail", "listing-search"]);
    }
  });

  test("a listed reasons row whose detail is unavailable is not written", async () => {
    serve([]);
    const built = await requireReconciliation(plCourtsAdapter).buildDecision(
      await rowById(REASONS_ID),
    );
    expect(built.type).toBe("detail-unavailable");
  });
});
