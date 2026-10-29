import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  assembleCzRegionalDecision,
  type CzRegionalApiItem,
  isCzRegionalApiItem,
  readCzRegionalDocument,
} from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { RETENTION_TEXT_ABSENCE } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import {
  validateAst,
  type ValidationResult,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { czRegionalFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";

import { czRegionalRetention } from "./cz-regional";

const ADAPTER_FIXTURES = new URL(
  "../../adapters/__fixtures__/",
  import.meta.url,
);
const PARSER_FIXTURES = new URL("../../parsers/__fixtures__/", import.meta.url);

const readGzip = async (url: URL): Promise<string> =>
  new TextDecoder().decode(Bun.gunzipSync(await Bun.file(url).bytes()));

const listingItem = async (docket: string): Promise<CzRegionalApiItem> => {
  const page: unknown = JSON.parse(
    await readGzip(new URL("cz-regional-listing.json.gz", ADAPTER_FIXTURES)),
  );
  const items = isRecord(page) ? page["items"] : undefined;
  return (
    (isUnknownArray(items) ? items : [])
      .filter(isCzRegionalApiItem)
      .find((item) => item.jednaciCislo === docket) ??
    panic(`the recorded listing has no ${docket}`)
  );
};

/** The decision the adapter builds from a recorded listing row and document. */
const built = async (
  docket: string,
  documentRaw: string | null,
): Promise<IngestionResult> => {
  const result = assembleCzRegionalDecision({
    item: await listingItem(docket),
    document: documentRaw === null ? null : readCzRegionalDocument(documentRaw),
    chain: null,
  });
  return result.type === "built"
    ? result.decision
    : panic(`${docket} did not build: ${result.type}`);
};

const projectionOf = async (decision: IngestionResult) =>
  czRegionalRetention.type === "checked"
    ? await czRegionalRetention.project(
        decision.sourceRaw ?? panic("the decision stores no raw"),
      )
    : panic("cz-regional is declared unparsed");

/** The oracle's verdict on the adapter's document against the projection. */
const retentionOf = async (
  decision: IngestionResult,
): Promise<ValidationResult> => {
  const ast = decision.documentAst;
  if (!hasUsableAst(ast)) {
    return panic("the adapter built no document");
  }
  const projection = await projectionOf(decision);
  return projection.type === "source"
    ? validateAst(projection.source, ast.blocks, projection.options)
    : panic(`projection answered ${projection.type}`);
};

/** The listing row only keys the decision; the document is what is checked. */
const DISTRICT_DOCKET = "18 C 130/2024-27";
const APPELLATE_DOCKET = "26 Co 43/2025-49";

const RECORDED: readonly { name: string; docket: string; document: URL }[] = [
  {
    name: "district finaldoc",
    docket: DISTRICT_DOCKET,
    document: new URL(
      "cz-regional-finaldoc-district.json.gz",
      ADAPTER_FIXTURES,
    ),
  },
  {
    name: "appellate finaldoc",
    docket: APPELLATE_DOCKET,
    document: new URL(
      "cz-regional-finaldoc-appellate.json.gz",
      ADAPTER_FIXTURES,
    ),
  },
  {
    name: "17 C 33/2019 finaldoc",
    docket: DISTRICT_DOCKET,
    document: new URL(
      "cz-regional-17-c-33-2019.finaldoc.json.gz",
      PARSER_FIXTURES,
    ),
  },
  {
    name: "26 C 151/2021 finaldoc",
    docket: DISTRICT_DOCKET,
    document: new URL(
      "cz-regional-26-c-151-2021.finaldoc.json.gz",
      PARSER_FIXTURES,
    ),
  },
];

describe("cz-regional retention against the finaldoc the court served", () => {
  for (const fixture of RECORDED) {
    test(`the ${fixture.name} keeps its text`, async () => {
      const result = await retentionOf(
        await built(fixture.docket, await readGzip(fixture.document)),
      );
      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  describe("the enrolled synthetic decision", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("keeps its text", async () => {
      const result = await retentionOf(
        await czRegionalFixture().buildDecision(),
      );
      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });

  test("a section served only as its plain rendering is still the text", async () => {
    const raw: unknown = JSON.parse(
      await readGzip(
        new URL("cz-regional-finaldoc-district.json.gz", ADAPTER_FIXTURES),
      ),
    );
    const document = isRecord(raw) ? raw : panic("finaldoc is not a record");
    const decision = await built(
      DISTRICT_DOCKET,
      JSON.stringify({
        ...document,
        justification: [],
        justificationText: "Soud žalobu zamítl, protože nárok nebyl prokázán.",
      }),
    );
    const result = await retentionOf(decision);
    expect(result.ok).toBe(true);
    const projection = await projectionOf(decision);
    expect(
      projection.type === "source" && typeof projection.source !== "string"
        ? projection.source.paragraphs
        : [],
    ).toContain("Soud žalobu zamítl, protože nárok nebyl prokázán.");
  });

  test("a row holding the listing alone has no publisher text", async () => {
    expect(await projectionOf(await built(DISTRICT_DOCKET, null))).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a raw that is not this source's envelope is reported unreadable", async () => {
    expect(
      czRegionalRetention.type === "checked" &&
        (await czRegionalRetention.project("{}")).type,
    ).toBe("unreadable");
    expect(
      czRegionalRetention.type === "checked" &&
        (
          await czRegionalRetention.project(
            encodeSourceRawEnvelope({ listing: "{}", document: "not json" }),
          )
        ).type,
    ).toBe("unreadable");
  });
});
