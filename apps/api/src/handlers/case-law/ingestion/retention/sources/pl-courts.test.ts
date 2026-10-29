import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  buildPlDecision,
  normalizeSaosDumpItem,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { plCourtsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-courts";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const FIXTURES = new URL("../../adapters/__fixtures__/", import.meta.url);

const readFixture = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

const listingRows = async (
  name: string,
): Promise<Record<string, unknown>[]> => {
  const page: unknown = JSON.parse(await readFixture(name));
  const items = isRecord(page) ? page["items"] : undefined;
  return isUnknownArray(items)
    ? items.filter(isRecord)
    : panic(`${name} holds no listing rows`);
};

const detailRecord = (detailRaw: string): Record<string, unknown> => {
  const payload: unknown = JSON.parse(detailRaw);
  const data = isRecord(payload) ? payload["data"] : undefined;
  return isRecord(data) ? data : panic("the detail holds no judgment record");
};

type Case = {
  readonly name: string;
  readonly build: () => IngestionResult | null;
};

/** Every judgment the adapter's tests build, with the parts it stores. */
const recordedCases = async (): Promise<Case[]> => {
  const cases: Case[] = [];
  for (const [file, part] of [
    ["pl-courts-dump-day.json.gz", "listing-dump"],
    ["pl-courts-search-day.json.gz", "listing-search"],
  ] as const) {
    for (const row of await listingRows(file)) {
      cases.push({
        name: `${file} #${JSON.stringify(row["id"])}`,
        build: () =>
          buildPlDecision({
            listingItem: normalizeSaosDumpItem(row),
            detail: null,
            rawParts: { [part]: JSON.stringify(row) },
          }),
      });
    }
  }
  const dumpRows = await listingRows("pl-courts-dump-day.json.gz");
  for (const file of [
    "pl-courts-detail-common.json.gz",
    "pl-courts-detail-chamber.json.gz",
  ]) {
    const detailRaw = await readFixture(file);
    const detail = detailRecord(detailRaw);
    // The common detail answers a judgment the dump lists; the chamber one
    // answers a judgment no captured listing holds, so its row is the id.
    const row = dumpRows.find(
      (candidate) => candidate["id"] === detail["id"],
    ) ?? {
      id: detail["id"],
    };
    cases.push({
      name: file,
      build: () =>
        buildPlDecision({
          listingItem: normalizeSaosDumpItem(row),
          detail: normalizeSaosDumpItem(detail),
          rawParts: {
            "listing-dump": JSON.stringify(row),
            detail: detailRaw,
          },
        }),
    });
  }
  return cases;
};

const project = async (sourceRaw: string) =>
  plCourtsRetention.type === "checked"
    ? await plCourtsRetention.project(sourceRaw)
    : panic("pl-courts is a checked source");

const cases = await recordedCases();

describe("pl-courts retention projection", () => {
  test.each(cases.map((entry) => [entry.name, entry] as const))(
    "%s keeps the text SAOS served",
    async (_name, entry) => {
      const decision = entry.build() ?? panic("the payloads built no decision");
      const ast = decision.documentAst;
      if (!hasUsableAst(ast)) {
        // Nothing parsed, so the pipeline checks nothing either.
        return;
      }
      const projection = await project(
        decision.sourceRaw ?? panic("no sourceRaw"),
      );
      if (projection.type !== "source") {
        panic(`unexpected projection ${projection.type}`);
      }
      const result = validateAst(
        projection.source,
        ast.blocks,
        projection.options,
      );
      console.info(
        `pl-courts retention ${entry.name}: ${result.stats.retainedPct.toFixed(1)}%, ${String(result.stats.missingWords.length)} missing words`,
      );
      // Retention is the verdict; structure warnings such as one block past
      // the size hint are the parser's own concern and do not fail it.
      expect(result.ok).toBe(true);
    },
  );

  test("a record with no text states none", async () => {
    const sourceRaw = encodeSourceRawEnvelope({
      "listing-dump": JSON.stringify({ id: 1, textContent: "" }),
      detail: JSON.stringify({ data: { id: 1, textContent: null } }),
    });
    expect(await project(sourceRaw)).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("the detail's text wins over the listing row's", async () => {
    const sourceRaw = encodeSourceRawEnvelope({
      "listing-search": JSON.stringify({ id: 1, textContent: "<p>row</p>" }),
      detail: JSON.stringify({ data: { id: 1, textContent: "<p>detail</p>" } }),
    });
    expect(await project(sourceRaw)).toEqual({
      type: "source",
      source: { type: "paragraphs", paragraphs: ["detail"] },
    });
  });

  test("legacy plain text is handed over line by line", async () => {
    const sourceRaw = encodeSourceRawEnvelope({
      "listing-dump": JSON.stringify({
        id: 1,
        textContent: "WYROK\n\nSąd\r\nNajwyższy",
      }),
    });
    expect(await project(sourceRaw)).toEqual({
      type: "source",
      source: { type: "paragraphs", paragraphs: ["WYROK", "Sąd", "Najwyższy"] },
    });
  });

  test("a payload that is no envelope is unreadable", async () => {
    expect(await project("{not json")).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    });
  });
});
