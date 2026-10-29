import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { assembleAtRisDecision } from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import { atRisRetention } from "@/api/handlers/case-law/ingestion/retention/sources/at-ris";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";
import {
  AT_RIS_SOURCES,
  atRisFixture,
  type AtRisFixtureAdapter,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

const ADAPTERS_DIR = new URL("../../adapters/__fixtures__/", import.meta.url);
const PARSERS_DIR = new URL("../../parsers/__fixtures__/", import.meta.url);

/** Each application's captured listing page, as the adapter tests read it. */
const CAPTURED_LISTINGS = {
  [ADAPTER_KEYS.AT_COURTS]: "at-ris-listing-justiz.json",
  [ADAPTER_KEYS.AT_VFGH]: "at-ris-listing-vfgh.json",
  [ADAPTER_KEYS.AT_VWGH]: "at-ris-listing-vwgh.json",
  [ADAPTER_KEYS.AT_BVWG]: "at-ris-listing-bvwg.json",
  [ADAPTER_KEYS.AT_LVWG]: "at-ris-listing-lvwg.json",
  [ADAPTER_KEYS.AT_ASYLGH]: "at-ris-listing-asylgh.json",
  [ADAPTER_KEYS.AT_UBAS]: "at-ris-listing-ubas.json",
  [ADAPTER_KEYS.AT_UVS]: "at-ris-listing-uvs.json",
  [ADAPTER_KEYS.AT_VERG]: "at-ris-listing-verg.json",
  [ADAPTER_KEYS.AT_UMSE]: "at-ris-listing-umse.json",
  [ADAPTER_KEYS.AT_BKS]: "at-ris-listing-bks.json",
} as const satisfies Record<AtRisFixtureAdapter, string>;

const ADAPTERS = [
  ADAPTER_KEYS.AT_COURTS,
  ADAPTER_KEYS.AT_VFGH,
  ADAPTER_KEYS.AT_VWGH,
  ADAPTER_KEYS.AT_BVWG,
  ADAPTER_KEYS.AT_LVWG,
  ADAPTER_KEYS.AT_ASYLGH,
  ADAPTER_KEYS.AT_UBAS,
  ADAPTER_KEYS.AT_UVS,
  ADAPTER_KEYS.AT_VERG,
  ADAPTER_KEYS.AT_UMSE,
  ADAPTER_KEYS.AT_BKS,
] satisfies AtRisFixtureAdapter[];

/** Every recorded decision document, under the application that printed it. */
const CAPTURED_DOCUMENTS = [
  { adapter: ADAPTER_KEYS.AT_COURTS, file: "at-ris-jjt-1925.xml" },
  { adapter: ADAPTER_KEYS.AT_COURTS, file: "at-ris-justiz-text.xml" },
  { adapter: ADAPTER_KEYS.AT_COURTS, file: "at-ris-justiz-headnote.xml" },
  { adapter: ADAPTER_KEYS.AT_VFGH, file: "at-ris-vfgh-text.xml" },
  { adapter: ADAPTER_KEYS.AT_VFGH, file: "at-ris-vfgh-headnote.xml" },
  { adapter: ADAPTER_KEYS.AT_VWGH, file: "at-ris-vwgh-text.xml" },
  { adapter: ADAPTER_KEYS.AT_VWGH, file: "at-ris-vwgh-headnote.xml" },
  { adapter: ADAPTER_KEYS.AT_UBAS, file: "at-ris-ubas-text.xml" },
  { adapter: ADAPTER_KEYS.AT_UMSE, file: "at-ris-umse-text.xml" },
  { adapter: ADAPTER_KEYS.AT_COURTS, file: "at-ris-ogh-sachwalter.xml" },
  { adapter: ADAPTER_KEYS.AT_COURTS, file: "at-ris-ogh-strafsache.xml" },
  { adapter: ADAPTER_KEYS.AT_VWGH, file: "at-ris-vwgh-randnummern.xml" },
  { adapter: ADAPTER_KEYS.AT_LVWG, file: "at-ris-lvwg-noe.xml" },
  { adapter: ADAPTER_KEYS.AT_LVWG, file: "at-ris-lvwg-kaernten.xml" },
  { adapter: ADAPTER_KEYS.AT_BVWG, file: "at-ris-bvwg-beschluss.xml" },
  { adapter: ADAPTER_KEYS.AT_VERG, file: "at-ris-verg-liste.xml" },
  { adapter: ADAPTER_KEYS.AT_VERG, file: "at-ris-verg-bva.xml" },
  { adapter: ADAPTER_KEYS.AT_UMSE, file: "at-ris-umse-abstand.xml" },
  { adapter: ADAPTER_KEYS.AT_BKS, file: "at-ris-bks-gesperrt.xml" },
] as const;

const firstListedItem = async (
  adapter: AtRisFixtureAdapter,
): Promise<Record<string, unknown>> => {
  const payload: unknown = await Bun.file(
    new URL(CAPTURED_LISTINGS[adapter], ADAPTERS_DIR),
  ).json();
  const answer = isRecord(payload) ? payload["OgdSearchResult"] : undefined;
  const results = isRecord(answer) ? answer["OgdDocumentResults"] : undefined;
  const items = isRecord(results) ? results["OgdDocumentReference"] : undefined;
  const item = (Array.isArray(items) ? items : [items]).find(isRecord);
  if (item === undefined) {
    throw new Error(`${adapter}: its capture states no listing row`);
  }
  return item;
};

const expectRetained = async (decision: IngestionResult) => {
  const ast = decision.documentAst;
  expect(hasUsableAst(ast)).toBe(true);
  const projection =
    atRisRetention.type === "checked"
      ? await atRisRetention.project(decision.sourceRaw ?? "")
      : undefined;
  if (projection?.type !== "source") {
    throw new Error(
      `no publisher text projected: ${JSON.stringify(projection)}`,
    );
  }
  const result = validateAst(projection.source, ast.blocks, projection.options);
  expect(
    result.ok,
    `retained ${result.stats.retainedPct.toFixed(1)}%, missing ${result.stats.missingWords.join(", ")}`,
  ).toBe(true);
};

describe("RIS retention projection", () => {
  test.each(ADAPTERS)(
    "%s: the synthetic decision keeps its publisher text",
    async (adapter: AtRisFixtureAdapter) => {
      await expectRetained(await atRisFixture(adapter).buildDecision());
    },
  );

  test.each(CAPTURED_DOCUMENTS.map(({ adapter, file }) => [file, adapter]))(
    "%s (%s): the recorded decision keeps its publisher text",
    async (file, adapter) => {
      const decision = assembleAtRisDecision(
        AT_RIS_SOURCES[adapter],
        await firstListedItem(adapter),
        { documentXml: await Bun.file(new URL(file, PARSERS_DIR)).text() },
      );
      expect(decision.isListingOnly).not.toBe(true);
      await expectRetained(decision);
    },
  );

  test("reports a document that lost its longest paragraph", async () => {
    const decision = assembleAtRisDecision(
      AT_RIS_SOURCES[ADAPTER_KEYS.AT_VFGH],
      await firstListedItem(ADAPTER_KEYS.AT_VFGH),
      {
        documentXml: await Bun.file(
          new URL("at-ris-vfgh-text.xml", PARSERS_DIR),
        ).text(),
      },
    );
    const projection =
      atRisRetention.type === "checked"
        ? await atRisRetention.project(decision.sourceRaw ?? "")
        : undefined;
    if (projection?.type !== "source") {
      throw new Error("the recorded decision projects publisher text");
    }
    const blocks = decision.documentAst.blocks;
    const longest = blocks
      .toSorted((left, right) => right.plainText.length - left.plainText.length)
      .at(0);
    expect(
      validateAst(
        projection.source,
        blocks.filter((block) => block !== longest),
        projection.options,
      ).ok,
    ).toBe(false);
  });

  test("stores a decision whose reading differs from print, with a typed marker", async () => {
    const xml = (
      await Bun.file(new URL("at-ris-vwgh-randnummern.xml", PARSERS_DIR)).text()
    ).replace(
      "</abschnitt></nutzdaten>",
      "<abstand>verloren</abstand></abschnitt></nutzdaten>",
    );
    const decision = assembleAtRisDecision(
      AT_RIS_SOURCES[ADAPTER_KEYS.AT_VWGH],
      await firstListedItem(ADAPTER_KEYS.AT_VWGH),
      { documentXml: xml },
    );
    expect(decision.isListingOnly).not.toBe(true);
    expect(hasUsableAst(decision.documentAst)).toBe(true);
    const fidelity: unknown = decision.metadata?.["textFidelity"];
    expect(fidelity).toEqual({
      status: "mismatch",
      missingChars: "verloren".length,
      extraChars: 0,
      firstDifferenceAt: expect.any(Number),
    });
  });

  test("leaves the page header and footer out of the publisher text", async () => {
    const xml = await Bun.file(
      new URL("at-ris-vfgh-text.xml", PARSERS_DIR),
    ).text();
    const projection =
      atRisRetention.type === "checked"
        ? await atRisRetention.project(
            encodeSourceRawEnvelope({ listing: "{}", "document-xml": xml }),
          )
        : undefined;
    if (
      projection?.type !== "source" ||
      typeof projection.source === "string"
    ) {
      throw new Error("the RIS projection states paragraphs");
    }
    expect(
      projection.source.paragraphs.some((paragraph) =>
        paragraph.includes("www.ris.bka.gv.at"),
      ),
    ).toBe(false);
    // The protected dash is printed, not dropped.
    expect(
      projection.source.paragraphs.some((paragraph) =>
        paragraph.includes("B-VG"),
      ),
    ).toBe(true);
  });

  test("states why a raw holds no decision text", async () => {
    if (atRisRetention.type !== "checked") {
      throw new Error("RIS decisions are checked");
    }
    expect(await atRisRetention.project("not an envelope")).toEqual({
      type: "unreadable",
      reason: "unreadable-envelope",
    });
    expect(
      await atRisRetention.project(encodeSourceRawEnvelope({ listing: "{}" })),
    ).toEqual({ type: "no-text", reason: "not-published" });
    expect(
      await atRisRetention.project(
        encodeSourceRawEnvelope({
          listing: "{}",
          "document-xml": "<risdok><metadaten/></risdok>",
        }),
      ),
    ).toEqual({ type: "unreadable", reason: "missing-text-part" });
  });
});
