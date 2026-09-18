/**
 * The declared inventory against what the publisher actually serves.
 *
 * The conformance suite drives each adapter with a fixture this repository
 * writes, so it certifies that every declared field has a target and that the
 * target is filled. What it cannot certify is that the declaration still
 * describes the publisher: a fixture is only ever as current as the day it
 * was written. These captures are answers the publisher served, one listing
 * page per application and one document per printed shape, and the checks
 * below are the ones that go red when the schema moves under the adapter.
 */

import { describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { assembleAtRisDecision } from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import type { AtRisSourceDefinition } from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import {
  AT_RIS_APPLICATIONS,
  AT_RIS_PART,
  atRisSourceFields,
  listAtRisSourceFields,
} from "@/api/handlers/case-law/ingestion/adapters/at-ris-fields";
import { isRecord } from "@/api/lib/type-guards";
import { AT_RIS_SOURCES } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import type { AtRisFixtureAdapter } from "@/api/tests/helpers/case-law-enrolled-fixtures";

const ADAPTERS_DIR = new URL("__fixtures__/", import.meta.url);
const PARSERS_DIR = new URL("../parsers/__fixtures__/", import.meta.url);

/** The capture of one application's listing page, named after its adapter. */
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

/** A captured document, and the application whose vocabulary it is printed in. */
const CAPTURED_DOCUMENTS = [
  { adapter: ADAPTER_KEYS.AT_COURTS, file: "at-ris-justiz-text.xml" },
  { adapter: ADAPTER_KEYS.AT_COURTS, file: "at-ris-justiz-headnote.xml" },
  { adapter: ADAPTER_KEYS.AT_VFGH, file: "at-ris-vfgh-text.xml" },
  { adapter: ADAPTER_KEYS.AT_VFGH, file: "at-ris-vfgh-headnote.xml" },
  { adapter: ADAPTER_KEYS.AT_VWGH, file: "at-ris-vwgh-text.xml" },
  { adapter: ADAPTER_KEYS.AT_VWGH, file: "at-ris-vwgh-headnote.xml" },
  { adapter: ADAPTER_KEYS.AT_UBAS, file: "at-ris-ubas-text.xml" },
  { adapter: ADAPTER_KEYS.AT_UMSE, file: "at-ris-umse-text.xml" },
] as const;

const capturedJson = async (file: string): Promise<unknown> =>
  await Bun.file(new URL(file, ADAPTERS_DIR)).json();

const listedItems = async (
  file: string,
): Promise<readonly Record<string, unknown>[]> => {
  const payload: unknown = await capturedJson(file);
  const answer = isRecord(payload) ? payload["OgdSearchResult"] : undefined;
  const results = isRecord(answer) ? answer["OgdDocumentResults"] : undefined;
  const items = isRecord(results) ? results["OgdDocumentReference"] : undefined;
  const listed = Array.isArray(items) ? items : [items];
  return listed.filter((item) => isRecord(item));
};

const documentXml = async (file: string): Promise<string> =>
  await Bun.file(new URL(file, PARSERS_DIR)).text();

const sourceOf = (adapter: AtRisFixtureAdapter): AtRisSourceDefinition =>
  AT_RIS_SOURCES[adapter];

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

describe("the RIS inventory against captured answers", () => {
  test.each(ADAPTERS)(
    "%s: every field its listing page states is declared",
    async (adapter: AtRisFixtureAdapter) => {
      const profile = AT_RIS_APPLICATIONS[adapter];
      const declared = atRisSourceFields(profile);
      const items = await listedItems(CAPTURED_LISTINGS[adapter]);
      expect(items.length).toBeGreaterThan(0);

      const undeclared = new Set<string>();
      for (const item of items) {
        for (const field of listAtRisSourceFields(profile, {
          [AT_RIS_PART.LISTING]: JSON.stringify(item),
        })) {
          if (declared[field] === undefined) {
            undeclared.add(field);
          }
        }
      }

      expect(
        [...undeclared],
        `${adapter}: its listing states fields nothing decided about: ${[...undeclared].join(", ")}.`,
      ).toEqual([]);
    },
  );

  test.each(CAPTURED_DOCUMENTS.map(({ adapter, file }) => [file, adapter]))(
    "%s: every section it prints is declared for %s",
    async (file, adapter) => {
      const profile = AT_RIS_APPLICATIONS[adapter];
      const declared = atRisSourceFields(profile);
      const stated = listAtRisSourceFields(profile, {
        [AT_RIS_PART.DOCUMENT_XML]: await documentXml(file),
      });

      expect(stated.length).toBeGreaterThan(0);
      expect(
        stated.filter((field) => declared[field] === undefined),
        `${file} prints sections nothing decided about.`,
      ).toEqual([]);
    },
  );

  test.each(ADAPTERS)(
    "%s: a captured listing row builds a decision rather than a listing",
    async (adapter: AtRisFixtureAdapter) => {
      const item = (await listedItems(CAPTURED_LISTINGS[adapter])).at(0);
      if (item === undefined) {
        throw new Error(`${adapter}: its capture states no listing row`);
      }

      const decision = assembleAtRisDecision(sourceOf(adapter), item, {
        documentXml: await documentXml("at-ris-justiz-text.xml"),
      });

      expect(decision.isListingOnly).not.toBe(true);
      expect(decision.metadata["detailStatus"]).toBeUndefined();
    },
  );

  test("the constitutional court's own summary reaches the row", async () => {
    const item = (await listedItems(CAPTURED_LISTINGS["at-vfgh"])).at(0);
    if (item === undefined) {
      throw new Error("the VfGH capture states no listing row");
    }

    const decision = assembleAtRisDecision(
      sourceOf(ADAPTER_KEYS.AT_VFGH),
      item,
      {
        documentXml: await documentXml("at-ris-vfgh-text.xml"),
      },
    );

    expect(decision.textFields.abstract.type).toBe("present");
    expect(decision.metadata["subjectIndex"]).not.toBeUndefined();
    expect(decision.metadata["keywords"]).not.toEqual([]);
  });

  test("an administrative-court headnote is stored as a legal sentence", async () => {
    const item = (await listedItems(CAPTURED_LISTINGS["at-vwgh"])).at(0);
    if (item === undefined) {
      throw new Error("the VwGH capture states no listing row");
    }

    const decision = assembleAtRisDecision(
      sourceOf(ADAPTER_KEYS.AT_VWGH),
      item,
      {
        documentXml: await documentXml("at-ris-vwgh-headnote.xml"),
      },
    );

    expect(decision.textFields.legalSentence.type).toBe("present");
    expect(decision.metadata["parentHeadnote"]).toContain("GRS");
  });

  test("the headnotes a captured answer names are kept with the decision", async () => {
    const item = (await listedItems(CAPTURED_LISTINGS["at-vfgh"])).find(
      (candidate) =>
        JSON.stringify(candidate).includes("JFT_20250605_24G00051_00"),
    );
    const answer: unknown = await capturedJson(
      "at-ris-headnote-listing-vfgh.json",
    );
    if (item === undefined) {
      throw new Error("the VfGH capture states no row for the headnote answer");
    }

    const decision = assembleAtRisDecision(
      sourceOf(ADAPTER_KEYS.AT_VFGH),
      item,
      {
        documentXml: await documentXml("at-ris-vfgh-text.xml"),
        headnoteListing: JSON.stringify(answer),
      },
    );

    const headnotes = decision.metadata["headnotes"];
    expect(Array.isArray(headnotes) ? headnotes : []).toHaveLength(1);
  });
});
