import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { assemblePlNsaDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import {
  PL_NSA_SNAPSHOT,
  type PlNsaDatasetRow,
} from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import { RETENTION_TEXT_ABSENCE } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { plNsaRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-nsa";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

const ROWS_JSON = new URL(
  "../../adapters/__fixtures__/pl-nsa-rows.json",
  import.meta.url,
);

type RecordedRow = {
  case: string;
  shard: number;
  row: number;
  values: PlNsaDatasetRow;
};

/** The rows the adapter's own tests replay, as the dataset served them. */
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
  return assemblePlNsaDecision({
    source: recorded.values,
    position: { shard, row: recorded.row },
    snapshot: PL_NSA_SNAPSHOT,
  }).decision;
};

const project = async (sourceRaw: string) =>
  plNsaRetention.type === "checked"
    ? await plNsaRetention.project(sourceRaw)
    : panic("pl-nsa is a checked source");

const rows = await recordedRows();

describe("pl-nsa retention projection", () => {
  test.each(rows.map((row) => [row.case, row] as const))(
    "%s keeps the dataset's full text",
    async (_name, recorded) => {
      const decision = build(recorded);
      const ast = decision.documentAst;
      const projection = await project(
        decision.sourceRaw ?? panic("no sourceRaw"),
      );
      if (projection.type !== "source" || !("blocks" in ast)) {
        panic(`unexpected projection ${projection.type}`);
      }
      const result = validateAst(
        projection.source,
        ast.blocks,
        projection.options,
      );
      console.info(
        `pl-nsa ${_name}: retainedPct=${result.stats.retainedPct.toFixed(1)} missingWords=${String(result.stats.missingWords.length)}`,
      );
      expect(result.ok).toBe(true);
    },
  );

  test("a row without full_text reads the section columns", async () => {
    const projection = await project(
      encodeSourceRawEnvelope({
        row: JSON.stringify({
          full_text: null,
          thesis: "Teza pierwsza.",
          sentence: "Sąd oddala skargę.\n\nDrugi akapit.",
          reasons_for_judgment: null,
          dissenting_opinion: "",
        }),
      }),
    );
    expect(projection).toEqual({
      type: "source",
      source: {
        type: "paragraphs",
        paragraphs: ["Teza pierwsza.", "Sąd oddala skargę.", "Drugi akapit."],
      },
    });
  });

  test("a row with no text column states no publisher text", async () => {
    expect(
      await project(encodeSourceRawEnvelope({ row: JSON.stringify({}) })),
    ).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a raw that is not the adapter's envelope is unreadable", async () => {
    expect((await project("not json")).type).toBe("unreadable");
    expect((await project(encodeSourceRawEnvelope({ row: "{" }))).type).toBe(
      "unreadable",
    );
  });
});
