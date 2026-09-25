/**
 * The same ruling stored by two Polish sources meets itself on `rulingKeys`.
 *
 * Each pair below is one judgment as both sources state it. One side is the
 * captured record; the other is a captured record of the same source with
 * the fields that name a ruling (id, court, docket, date, kind) restated to
 * this judgment, since no capture holds the same judgment from both sources.
 * Every other field is what the source served.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildPlDecision,
  normalizeSaosDumpItem,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { assemblePlNsaDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import { PL_NSA_SNAPSHOT } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import {
  assemblePlUodoDecision,
  normalizePlUodoRow,
  plUodoRawPartsOf,
} from "@/api/handlers/case-law/ingestion/adapters/pl-uodo";
import { readGzipJson } from "@/api/lib/gzip-json";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { plTkFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const keysOf = (decision: IngestionResult): string[] => {
  const keys = decision.metadata["rulingKeys"];
  return Array.isArray(keys)
    ? keys.filter((key): key is string => typeof key === "string")
    : [];
};

const shared = (left: IngestionResult, right: IngestionResult): string[] =>
  keysOf(left).filter((key) => keysOf(right).includes(key));

// ── The administrative courts: UODO's record and the courts' own ──

/** A regional administrative court judgment the UODO portal files. */
const UODO_RULING = "urn:ndoc:court:pl:sa:2023:ii_sa-wa_996";

const uodoRuling = async (): Promise<IngestionResult> => {
  const listed = await readGzipJson(
    new URL("pl-uodo-listing-2023.json.gz", FIXTURES),
  );
  const record =
    (isUnknownArray(listed) ? listed : [])
      .filter(isRecord)
      .find((row) => row["refid"] === UODO_RULING) ??
    panic("the pl-uodo listing fixture lost its ruling");
  const built = assemblePlUodoDecision({
    row: normalizePlUodoRow(record),
    body: undefined,
    rawParts: plUodoRawPartsOf(record, undefined),
  });
  return built.type === "built"
    ? built.decision
    : panic(`the pl-uodo ruling did not build: ${built.type}`);
};

/** The same judgment as the administrative courts' dataset states it. */
const nsaRow = async (
  restated: Record<string, unknown>,
): Promise<IngestionResult> => {
  const recorded: unknown = await Bun.file(
    new URL("pl-nsa-rows.json", FIXTURES),
  ).json();
  const entry = (isUnknownArray(recorded) ? recorded : [])
    .filter(isRecord)
    .find(
      (candidate) => candidate["case"] === "wsa-thesis-official-collection",
    );
  const values = isRecord(entry) ? entry["values"] : undefined;
  if (!isRecord(values)) {
    return panic("the pl-nsa fixture holds no WSA judgment");
  }
  const shard =
    PL_NSA_SNAPSHOT.shards[0] ?? panic("the pinned revision has no shard");
  return assemblePlNsaDecision({
    source: {
      ...values,
      judgment_id: "/doc/CB7D6E6DEE",
      docket_number: "II SA/Wa 996/23",
      judgment_date: "2023-11-06T00:00:00+01:00",
      court_name: "Wojewódzki Sąd Administracyjny w Warszawie",
      judgment_type: "Wyrok WSA w Warszawie",
      ...restated,
    },
    position: { shard, row: 0 },
    snapshot: PL_NSA_SNAPSHOT,
  }).decision;
};

describe("an administrative court's ruling filed by the UODO portal", () => {
  test("pairs with the courts' own row on the portal id and on court, docket, date and kind", async () => {
    const uodo = await uodoRuling();
    const nsa = await nsaRow({});
    expect(shared(uodo, nsa).toSorted()).toEqual(
      [
        "sa-doc|CB7D6E6DEE",
        "sa|wojewódzki sąd administracyjny w warszawie|IISA/WA996/23|2023-11-06|wyrok",
      ].toSorted(),
    );
  });

  test("pairs on court, docket, date and kind where one side states no portal id", async () => {
    const nsa = await nsaRow({ judgment_id: "dataset-row-without-portal-id" });
    expect(shared(await uodoRuling(), nsa)).toEqual([
      "sa|wojewódzki sąd administracyjny w warszawie|IISA/WA996/23|2023-11-06|wyrok",
    ]);
  });

  test("another ruling in the same case does not pair", async () => {
    const nsa = await nsaRow({
      judgment_id: "/doc/0000000001",
      judgment_date: "2023-12-01T00:00:00+01:00",
      judgment_type: "Postanowienie WSA w Warszawie",
    });
    expect(shared(await uodoRuling(), nsa)).toEqual([]);
  });
});

// ── The Constitutional Tribunal: SAOS and the Tribunal's portal ──

/** The Tribunal's judgment in SK 14/11 as SAOS republished it. */
const saosTribunalRow = (
  restated: Record<string, unknown> = {},
): IngestionResult => {
  const item = {
    id: 90_001,
    courtType: "CONSTITUTIONAL_TRIBUNAL",
    // SAOS prints the Tribunal's prefix with a dot.
    courtCases: [{ caseNumber: "SK. 14/11" }],
    judgmentType: "SENTENCE",
    judgmentDate: "2013-10-22",
    judges: [],
    textContent:
      "<p>WYROK</p><p>Sygn. akt SK 14/11</p><p>Art. 357 § 1 jest niezgodny z art. 45 ust. 1 Konstytucji.</p>",
    ...restated,
  };
  return (
    buildPlDecision({
      listingItem: normalizeSaosDumpItem(item),
      detail: null,
      rawParts: { "listing-dump": JSON.stringify(item) },
    }) ?? panic("the SAOS Tribunal row did not build")
  );
};

describe("a Constitutional Tribunal ruling in SAOS and on the Tribunal's portal", () => {
  test("pairs on docket, date and kind, whatever spelling each source gives the docket", async () => {
    const portal = await plTkFixture().buildDecision();
    expect(shared(saosTribunalRow(), portal)).toEqual([
      "tk|sk 14/11|2013-10-22|wyrok",
    ]);
  });

  test("another ruling in the same case does not pair", async () => {
    const portal = await plTkFixture().buildDecision();
    expect(
      shared(saosTribunalRow({ judgmentType: "DECISION" }), portal),
    ).toEqual([]);
    expect(
      shared(saosTribunalRow({ judgmentDate: "2013-10-23" }), portal),
    ).toEqual([]);
  });

  test("a common court's row with a Tribunal-shaped docket carries no Tribunal key", () => {
    const common = saosTribunalRow({
      courtType: "COMMON",
      courtCases: [{ caseNumber: "II K 14/11" }],
    });
    expect(keysOf(common).some((key) => key.startsWith("tk|"))).toBe(false);
  });
});
