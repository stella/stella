/**
 * What this adapter makes of the payloads SAOS actually serves.
 *
 * Driven from recorded captures rather than from objects written here: the
 * questions are what the publisher states and what the row keeps, and a
 * hand-built payload only ever states what its author already knew to look
 * for. The synthetic fixture in `case-law-enrolled-fixtures.ts` is the
 * complement — it fills every field so the conformance suites can exercise
 * every disposition, which no single real decision does.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceRawParts,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildPlDecision,
  normalizeSaosDumpItem,
  plCourtsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const DUMP_PAGE = "pl-courts-dump-day.json.gz";
const SEARCH_PAGE = "pl-courts-search-day.json.gz";
const COMMON_DETAIL = "pl-courts-detail-common.json.gz";
const CHAMBER_DETAIL = "pl-courts-detail-chamber.json.gz";

const readFixture = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

/** The rows of a recorded listing page, exactly as the publisher sent them. */
const listingRows = async (
  name: string,
): Promise<Record<string, unknown>[]> => {
  const page: unknown = JSON.parse(await readFixture(name));
  const items = isRecord(page) ? page["items"] : undefined;
  return isUnknownArray(items)
    ? items.filter(isRecord)
    : panic(`${name} holds no listing rows`);
};

const rowById = async (
  name: string,
  id: number,
): Promise<Record<string, unknown>> =>
  (await listingRows(name)).find((row) => row["id"] === id) ??
  panic(`${name} lists no judgment ${id}`);

/** The judgment record inside a recorded per-judgment answer. */
const detailRecord = async (name: string): Promise<Record<string, unknown>> => {
  const payload: unknown = JSON.parse(await readFixture(name));
  const data = isRecord(payload) ? payload["data"] : undefined;
  return isRecord(data) ? data : panic(`${name} holds no judgment record`);
};

type DecisionFromOptions = {
  listingRow: Record<string, unknown>;
  detail: Record<string, unknown> | null;
  listingPart?: "listing-dump" | "listing-search";
};

const decisionFrom = ({
  listingRow,
  detail,
  listingPart = "listing-dump",
}: DecisionFromOptions): IngestionResult =>
  buildPlDecision({
    listingItem: normalizeSaosDumpItem(listingRow),
    detail: detail === null ? null : normalizeSaosDumpItem(detail),
    rawParts: {
      [listingPart]: JSON.stringify(listingRow),
      ...(detail === null ? {} : { detail: JSON.stringify({ data: detail }) }),
    },
  }) ?? panic("the recorded payloads built no decision");

const storedParts = (decision: IngestionResult): SourceRawParts =>
  decodeSourceRawEnvelope(decision.sourceRaw ?? "") ??
  panic("the decision stores no envelope");

const namesInRole = (
  decision: IngestionResult,
  role: string,
): readonly string[] =>
  (decision.judges ?? [])
    .filter((judge) => judge.role === role)
    .map((judge) => judge.nameAsPrinted);

describe("pl-courts reads what SAOS serves", () => {
  test("every field the recorded payloads state has a disposition", async () => {
    const { fields, listSourceFields } = plCourtsAdapter.sourceFields;
    const parts: SourceRawParts = {
      "listing-dump": JSON.stringify(await rowById(DUMP_PAGE, 332_735)),
      "listing-search": JSON.stringify(await rowById(SEARCH_PAGE, 332_104)),
      detail: await readFixture(CHAMBER_DETAIL),
    };

    const stated = await listSourceFields(parts);
    const undeclared = stated.filter((field) => fields[field] === undefined);

    expect(
      undeclared,
      `SAOS states fields nothing decided about: ${undeclared.join(", ")}`,
    ).toEqual([]);
    // The captures are of three payloads of one publisher, so they state less
    // than the inventory declares; what they must not do is state more.
    expect(stated.length).toBeGreaterThan(30);
  });

  test("the whole bench reaches the row, in the roles SAOS marks it with", async () => {
    const detail = await detailRecord(CHAMBER_DETAIL);
    const decision = decisionFrom({
      listingRow: { id: detail["id"] },
      detail,
    });

    // `REASONS_FOR_JUDGMENT_AUTHOR` sits beside `REPORTING_JUDGE` on the same
    // judge and states nothing the reporting role does not, so it adds no
    // second row for them.
    expect(namesInRole(decision, DECISION_JUDGE_ROLE.RAPPORTEUR)).toEqual([
      "Józef Szewczyk",
    ]);
    expect(namesInRole(decision, DECISION_JUDGE_ROLE.PRESIDING)).toEqual([
      "Józef Dołhy",
    ]);
    expect(namesInRole(decision, DECISION_JUDGE_ROLE.PANEL_MEMBER)).toEqual([
      "Dariusz Świecki",
    ]);
  });

  test("the fields the listing allowlist used to drop reach the row", async () => {
    const detail = await detailRecord(CHAMBER_DETAIL);
    const decision = decisionFrom({
      listingRow: { id: detail["id"] },
      detail,
    });

    expect(decision.metadata).toMatchObject({
      personnelType: "THREE_PERSON",
      judgmentForm: "wyrok SN",
      chambers: [expect.objectContaining({ name: "Izba Karna" })],
    });
    // The same fields survive a listing row that carries them, which is the
    // half a decision with no detail answer depends on.
    const fromListing = decisionFrom({ listingRow: detail, detail: null });
    expect(fromListing.metadata).toMatchObject({
      personnelType: "THREE_PERSON",
      judgmentForm: "wyrok SN",
    });
  });

  test("a bench member SAOS marks with no role still reaches the row", async () => {
    const decision = decisionFrom({
      listingRow: await rowById(DUMP_PAGE, 332_735),
      detail: await detailRecord(COMMON_DETAIL),
    });

    expect(namesInRole(decision, DECISION_JUDGE_ROLE.PRESIDING)).toEqual([
      "Piotr Rajczakowski",
    ]);
    expect(namesInRole(decision, DECISION_JUDGE_ROLE.PANEL_MEMBER)).toEqual([
      "Agnieszka Terpiłowska",
      "Maciej Ejsmont",
    ]);
    expect(namesInRole(decision, DECISION_JUDGE_ROLE.RAPPORTEUR)).toEqual([]);
  });

  test("a dissent names its author as a judge of the decision", async () => {
    const detail = await detailRecord(CHAMBER_DETAIL);
    const decision = decisionFrom({
      listingRow: { id: detail["id"] },
      detail: {
        ...detail,
        dissentingOpinions: [
          {
            textContent: "Zdanie odrębne.",
            authors: ["Dariusz Świecki"],
          },
        ],
      },
    });

    // The same judge sat on the bench and wrote separately; both are facts of
    // the decision and the two rows key differently.
    expect(namesInRole(decision, DECISION_JUDGE_ROLE.DISSENTING)).toEqual([
      "Dariusz Świecki",
    ]);
    expect(namesInRole(decision, DECISION_JUDGE_ROLE.PANEL_MEMBER)).toEqual([
      "Dariusz Świecki",
    ]);
    expect(decision.metadata["dissentingOpinions"]).toEqual([
      { textContent: "Zdanie odrębne.", authors: ["Dariusz Świecki"] },
    ]);
  });

  test("each response is kept as its own envelope part", async () => {
    const dumpRow = await rowById(DUMP_PAGE, 332_735);
    const decision = decisionFrom({
      listingRow: dumpRow,
      detail: await detailRecord(COMMON_DETAIL),
    });

    expect(decision.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    const parts = storedParts(decision);
    expect(Object.keys(parts).toSorted()).toEqual(["detail", "listing-dump"]);
    // The part is the publisher's row, not this adapter's reading of it.
    expect(JSON.parse(parts["listing-dump"] ?? "")).toEqual(dumpRow);
  });

  test("the search row is kept apart from the dump row", async () => {
    const searchRow = await rowById(SEARCH_PAGE, 332_104);
    const decision = decisionFrom({
      listingRow: searchRow,
      detail: null,
      listingPart: "listing-search",
    });

    expect(Object.keys(storedParts(decision))).toEqual(["listing-search"]);
  });
});

describe("pl-courts decision dates", () => {
  test("a year no judgment can carry falls back to the upstream id", async () => {
    const row = await rowById(DUMP_PAGE, 332_735);
    const decision = decisionFrom({
      listingRow: { ...row, judgmentDate: "0208-03-14" },
      detail: null,
    });

    // `…_II_Ca_000236_2018_Uz_2018-03-22_001`: the deciding court's own date
    // for the document, which is what the corrupt year was meant to be.
    expect(decision.decisionDate).toBe("2018-03-22");
  });

  test("a stated date within range is what the row carries", async () => {
    const decision = decisionFrom({
      listingRow: await rowById(DUMP_PAGE, 332_735),
      detail: null,
    });

    expect(decision.decisionDate).toBe("2018-03-22");
  });

  test("no date is stored where neither the record nor its id states one", async () => {
    const row = await rowById(DUMP_PAGE, 332_735);
    const source = isRecord(row["source"]) ? row["source"] : {};
    const decision = decisionFrom({
      listingRow: {
        ...row,
        judgmentDate: "0208-03-14",
        source: { ...source, judgmentId: "dec1bfc4e752237043d129d346fa2543" },
      },
      detail: null,
    });

    // The document's prose recites dates of its own; none of them is the
    // judgment's, so the row states nothing rather than one of them.
    expect(decision.decisionDate).toBeUndefined();
  });
});

describe("pl-courts replays a stored row", () => {
  const reparse =
    plCourtsAdapter.reparseStoredRaw ??
    panic("pl-courts declares no reparseStoredRaw");

  test("the wrapper written before the envelope is still readable", async () => {
    const dumpItem = await rowById(DUMP_PAGE, 332_735);
    const detail = await detailRecord(COMMON_DETAIL);
    const legacy = JSON.stringify({ dumpItem, detail });

    const outcome = await reparse({
      raw: new TextEncoder().encode(legacy),
      contentType: "application/json",
      caseNumber: "II Ca 236/18",
      sourceDocumentId: "332735",
      language: "pl",
      court: "Sąd Okręgowy w Świdnicy",
      ecli: null,
      decisionDate: "2015-06-12",
      decisionType: "postanowienie",
      sourceUrl: "https://www.saos.org.pl/judgments/332735",
      documentUrl: null,
      metadata: {},
    });

    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    // What the replay is for: the bench and the date the row could not carry
    // when it was written.
    expect(namesInRole(outcome.result, DECISION_JUDGE_ROLE.PRESIDING)).toEqual([
      "Piotr Rajczakowski",
    ]);
    expect(outcome.result.decisionDate).toBe("2018-03-22");
    expect(Object.keys(storedParts(outcome.result)).toSorted()).toEqual([
      "detail",
      "listing-dump",
    ]);
  });

  test("a payload stating another decision is refused", async () => {
    const dumpItem = await rowById(DUMP_PAGE, 332_735);
    const outcome = await reparse({
      raw: new TextEncoder().encode(JSON.stringify({ dumpItem, detail: null })),
      contentType: "application/json",
      caseNumber: "II Ca 999/18",
      sourceDocumentId: "332735",
      language: "pl",
      court: "Sąd Okręgowy w Świdnicy",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    });

    expect(outcome.type).toBe("rejected");
  });
});
