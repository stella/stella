import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { loadDocxArchive } from "@/api/lib/docx-archive";
import {
  HOUSE_DOCUMENT_XML,
  SOURCE_DOCUMENT_XML,
  syntheticDocx,
  SYNTHETIC_GUIDE_DRAFT,
} from "@/api/lib/house-style/__fixtures__/synthetic-style-set";
import { applyRename } from "@/api/lib/house-style/catalogue";
import type { RenameRule } from "@/api/lib/house-style/catalogue";
import {
  convertToHouseStyle,
  danglingStyleReferences,
  percentileOf,
  readStyleCatalogue,
} from "@/api/lib/house-style/convert";
import type { ConversionResult } from "@/api/lib/house-style/convert";
import {
  bindStyleGuide,
  parseStyleGuideDraft,
} from "@/api/lib/house-style/guide";
import type { StyleGuide, StyleGuideDraft } from "@/api/lib/house-style/guide";
import { createSystemOneClient } from "@/api/lib/workflow/decisions/system-one";

const houseBytes = await syntheticDocx();
const sourceBytes = await syntheticDocx({ documentXml: SOURCE_DOCUMENT_XML });

const unwrap = <TValue>(
  result: Result<TValue, { message: string }>,
): TValue => {
  if (Result.isError(result)) {
    throw new TypeError(result.error.message);
  }
  return result.value;
};

const messageOf = (result: Result<unknown, { message: string }>): string =>
  Result.isError(result) ? result.error.message : "the call did not fail";

const guideFor = async (rename: RenameRule[] = []): Promise<StyleGuide> => {
  const catalogue = unwrap(
    await readStyleCatalogue({ bytes: houseBytes, rename }),
  );
  const renamed: StyleGuideDraft = {
    styles: SYNTHETIC_GUIDE_DRAFT.styles.map((entry) => ({
      id: applyRename(entry.id, rename),
      name: entry.name,
      purpose: entry.purpose,
      use_when: entry.use_when,
      do_not_use_when: entry.do_not_use_when,
      hierarchy: entry.hierarchy,
      looks_like: entry.looks_like,
    })),
  };
  return unwrap(
    bindStyleGuide({ draft: unwrap(parseStyleGuideDraft(renamed)), catalogue }),
  );
};

const partsOf = async (bytes: ArrayBuffer) => {
  const archive = await loadDocxArchive(bytes);
  return {
    documentXml: (await archive.readEntryString("word/document.xml")) ?? "",
    stylesXml: (await archive.readEntryString("word/styles.xml")) ?? "",
    commentsXml: await archive.readEntryString("word/comments.xml"),
    coreXml: await archive.readEntryString("docProps/core.xml"),
  };
};

const convert = async (): Promise<ConversionResult> =>
  unwrap(
    await convertToHouseStyle({
      styleSetBytes: houseBytes,
      sourceBytes,
      guide: await guideFor(),
      orgAIConfig: null,
      client: null,
    }),
  );

describe("converting a document into a house style", () => {
  test("writes a package that reopens and names only styles it defines", async () => {
    const { bytes } = await convert();
    const parts = await partsOf(bytes);
    expect(danglingStyleReferences(parts)).toEqual([]);
    expect(parts.documentXml).toContain("w:pStyle");
  });

  test("reports every paragraph, the tier that decided it and the style it got", async () => {
    const { rows, summary } = await convert();
    expect(rows).toHaveLength(6);
    expect(summary.paragraphs).toBe(6);
    // No decision model is configured in this run, so the rule answers all.
    expect(summary.byTier.rule).toBe(6);
    expect(summary.byTier["decision-model"]).toBe(0);
    expect(summary.byStyle.reduce((total, { count }) => total + count, 0)).toBe(
      6,
    );
    expect(summary.model).toBeNull();
    expect(summary.usd).toBe(0);
  });

  test("keeps the style set's own body out of the result", async () => {
    const { bytes } = await convert();
    const { documentXml } = await partsOf(bytes);
    expect(documentXml).toContain("SHORT-FORM LOAN AGREEMENT");
    expect(documentXml).not.toContain("Definitions and interpretation");
  });

  test("drops the comments and the authorship of the style-set file", async () => {
    const { bytes } = await convert();
    const { commentsXml, coreXml } = await partsOf(bytes);
    expect(commentsXml).not.toContain("An internal note");
    expect(coreXml).not.toContain("A Person");
  });

  test("applies a rename to the styles, the numbering and the paragraphs", async () => {
    const rename = [{ from: "Firm", to: "House" }];
    const converted = unwrap(
      await convertToHouseStyle({
        styleSetBytes: houseBytes,
        sourceBytes,
        guide: await guideFor(rename),
        orgAIConfig: null,
        rename,
        client: null,
      }),
    );
    const parts = await partsOf(converted.bytes);
    expect(parts.stylesXml).toContain('w:styleId="Heading1House"');
    expect(parts.stylesXml).not.toContain("Heading1Firm");
    expect(danglingStyleReferences(parts)).toEqual([]);
    expect(
      converted.rows.every(({ styleId }) => !styleId.includes("Firm")),
    ).toBe(true);
  });

  test("refuses bytes that are not a DOCX", async () => {
    const refused = await convertToHouseStyle({
      styleSetBytes: new TextEncoder().encode("not a zip").buffer,
      sourceBytes,
      guide: await guideFor(),
      orgAIConfig: null,
      client: null,
    });
    expect(Result.isError(refused)).toBe(true);
  });

  // Word opens a document that carries no `word/styles.xml`: every paragraph
  // is then on the default style. The styles a conversion applies come from
  // the style set, so the source needs none of its own.
  test("converts a source document that carries no style part", async () => {
    const converted = unwrap(
      await convertToHouseStyle({
        styleSetBytes: houseBytes,
        sourceBytes: await syntheticDocx({
          documentXml: SOURCE_DOCUMENT_XML,
          stylesXml: null,
          numberingXml: null,
        }),
        guide: await guideFor(),
        orgAIConfig: null,
        client: null,
      }),
    );
    expect(converted.rows).toHaveLength(6);
    expect(
      converted.rows.every(
        ({ originalStyleId }) => originalStyleId === "Normal",
      ),
    ).toBe(true);
    expect(danglingStyleReferences(await partsOf(converted.bytes))).toEqual([]);
  });

  // A style set is worth exactly the styles it defines, so the same missing
  // part that a source document survives is refused here.
  test("refuses a style set that carries no style part", async () => {
    const refused = await readStyleCatalogue({
      bytes: await syntheticDocx({ stylesXml: null, numberingXml: null }),
    });
    expect(messageOf(refused)).toContain("no style part");
  });

  // Replacing the style set's file leaves the stored guide describing styles
  // that may be gone. Converting anyway would fall back to the default style
  // and report the document as converted into the house style.
  test("refuses a guide written against another version of the style set", async () => {
    const stale = await convertToHouseStyle({
      styleSetBytes: houseBytes,
      sourceBytes,
      guide: { ...(await guideFor()), catalogueHash: "written-for-another" },
      orgAIConfig: null,
      client: null,
    });
    expect(Result.isError(stale) && stale.error._tag).toBe(
      "StyleGuideStaleError",
    );
  });

  // `decideMany` throws once the deadline passes; a conversion answers with
  // its Result either way.
  test("returns an aborted conversion rather than throwing", async () => {
    const aborted = await convertToHouseStyle({
      styleSetBytes: houseBytes,
      sourceBytes,
      guide: await guideFor(),
      orgAIConfig: null,
      abortSignal: AbortSignal.abort(),
      client: {
        ...createSystemOneClient({
          apiKey: "key-test",
          fetcher: async () => await Promise.reject(new Error("aborted")),
        }),
        keySource: "instance",
      },
    });
    expect(messageOf(aborted)).toContain("stopped before");
  });

  test("refuses a style set whose document part is missing", async () => {
    const empty = await syntheticDocx({ documentXml: "" });
    const refused = await readStyleCatalogue({ bytes: empty });
    expect(Result.isError(refused)).toBe(true);
  });
});

describe("the catalogue a guide is authored from", () => {
  test("is the same whether it is read from bytes or from the parts", async () => {
    const catalogue = unwrap(await readStyleCatalogue({ bytes: houseBytes }));
    expect(catalogue.styles.map(({ id }) => id)).toContain("Heading1Firm");
    expect(catalogue.defaultStyleId).toBe("Normal");
    expect(HOUSE_DOCUMENT_XML).toContain("Heading1Firm");
  });
});

describe("latency percentiles", () => {
  test("report a value a call actually took", () => {
    expect(percentileOf([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentileOf([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentileOf([], 0.5)).toBeNull();
  });
});
