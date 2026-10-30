/**
 * The text of a common court's judgment, as both of its publishers serve it.
 *
 * SAOS and the courts' portal carry the same document from the courts' own
 * editor: SAOS as HTML it renders, the portal as the editor's XML. Every
 * capture here is recorded, and where both publishers hold one judgment the
 * two copies are the oracle for each other: what one reads and the other
 * does not is a reading defect, not the court's text.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasInlineChildren } from "@stll/legal-ast/document-ast";
import type { Block, Inline } from "@stll/legal-ast/document-ast";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildPlDecision,
  normalizeSaosDumpItem,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  assemblePlNcourtDecision,
  readPlNcourtListing,
} from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@/api/lib/case-law/decision-text";
import { isRecord } from "@/api/lib/type-guards";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const SOFT_HYPHEN = String.fromCodePoint(0xad);

const fixture = async (name: string): Promise<string> => {
  const bytes = await Bun.file(new URL(name, FIXTURES)).bytes();
  return new TextDecoder().decode(
    name.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
  );
};

/** SAOS's copy, from its recorded per-judgment record. */
const saosDecision = async (name: string): Promise<IngestionResult> => {
  const payload: unknown = JSON.parse(await fixture(name));
  const record = isRecord(payload) ? payload["data"] : undefined;
  if (!isRecord(record)) {
    return panic(`${name} holds no judgment record`);
  }
  // The record stands alone: the listing contributes only the id it was
  // read under, so every field asserted here is the record's.
  const listed = { id: record["id"] };
  return (
    buildPlDecision({
      listingItem: normalizeSaosDumpItem(listed),
      detail: normalizeSaosDumpItem(record),
      rawParts: {
        "listing-dump": JSON.stringify(listed),
        detail: JSON.stringify(payload),
      },
    }) ?? panic(`${name} built no decision`)
  );
};

/** The portal's copy: the listed row, the record and the document. */
const portalDecision = async (id: string): Promise<IngestionResult> => {
  const listing =
    readPlNcourtListing(await fixture(`pl-ncourt-listing-${id}.xml`)) ??
    panic(`the listing of ${id} did not read`);
  const listingXml =
    listing.fragments.find((fragment) => fragment.includes(`<id>${id}</id>`)) ??
    panic(`the listing does not list ${id}`);
  const outcome = assemblePlNcourtDecision({
    listingXml,
    detailXml: await fixture(`pl-ncourt-detail-${id}.xml`),
    contentXml: await fixture(`pl-ncourt-content-${id}.xml.gz`),
  });
  return outcome.type === "built"
    ? outcome.decision
    : panic(`${id} built ${outcome.type}`);
};

const blocksOf = (decision: IngestionResult): readonly Block[] =>
  "blocks" in decision.documentAst ? decision.documentAst.blocks : [];

const paragraphsOf = (decision: IngestionResult): string[] =>
  blocksOf(decision).flatMap((block) =>
    block.type === "paragraph" ? [block.plainText] : [],
  );

/** Each superscript, with the twelve characters set before it. */
const superscriptsOf = (decision: IngestionResult): string[] => {
  const found: string[] = [];
  const walk = (inlines: readonly Inline[], before: string): string => {
    let text = before;
    for (const inline of inlines) {
      if (inline.type === "text") {
        text += inline.text;
      } else if (inline.type === "superscript") {
        const label = walk(inline.children, "");
        found.push(`${text.slice(-12)}^${label}`);
        text += label;
      } else if (hasInlineChildren(inline)) {
        text = walk(inline.children, text);
      }
    }
    return text;
  };
  for (const block of blocksOf(decision)) {
    if ("inlines" in block) {
      walk(block.inlines, "");
    }
  }
  return found;
};

/** Both publishers' copies of one judgment. */
const PAIRS = [
  [
    "pl-courts-detail-501501.json.gz",
    "154505000000603_II_C_003763_2020_Uz_2022-12-14_001",
  ],
  [
    "pl-courts-detail-472699.json.gz",
    "154500000000503_I_ACa_000823_2021_Uz_2022-05-04_003",
  ],
  [
    "pl-courts-detail-628.json.gz",
    "152500000000503_I_ACa_000420_2012_Uz_2012-09-20_001",
  ],
] as const;

const SAOS_ONLY = ["pl-courts-detail-303939.json.gz"] as const;

const PORTAL_ONLY = [
  "151005000004027_VIII_GC_000227_2021_Uz_2021-12-23_002",
  "151025200001006_II_K_000937_2025_Uz_2026-03-09_001",
  "152510000004021_VIII_U_002067_2016_Uz_2016-12-29_001",
] as const;

const everyDecision = async (): Promise<IngestionResult[]> => [
  ...(await Promise.all(
    [...PAIRS.map(([saos]) => saos), ...SAOS_ONLY].map(saosDecision),
  )),
  ...(await Promise.all(
    [...PAIRS.map(([, portal]) => portal), ...PORTAL_ONLY].map(portalDecision),
  )),
];

describe("a common court's judgment reads as the court wrote it", () => {
  test.each(PAIRS)(
    "SAOS's copy %s and the portal's copy %s read to the same text",
    async (saos, portal) => {
      const fromSaos = await saosDecision(saos);
      const fromPortal = await portalDecision(portal);

      expect(fromSaos.fulltext ?? "").toBe(fromPortal.fulltext ?? "");
    },
  );

  test("no line inside a paragraph goes on with a sentence left mid-phrase", async () => {
    // A line break the editor set to wrap a line ("zawarli⏎z pozwanym"),
    // and the indentation SAOS prints around a marked word ("Sąd⏎meriti"),
    // both left a sentence broken across lines. A line that opens in lower
    // case, and is not a point of its own, after a line the court did not
    // end with punctuation, is that sentence going on.
    const broken = (await everyDecision()).flatMap((decision) =>
      paragraphsOf(decision).flatMap((paragraph) => {
        const lines = paragraph.split("\n");
        return lines.slice(1).flatMap((line, index) => {
          const previous = lines[index] ?? "";
          return /^\p{Ll}/u.test(line) &&
            !/^\p{Ll}[.)](?:\s|$)/u.test(line) &&
            !/[.:;!?]$/u.test(previous.trimEnd())
            ? [`${previous.slice(-30)}⏎${line.slice(0, 30)}`]
            : [];
        });
      }),
    );

    expect(broken).toEqual([]);
  });

  test("a sentence the editor wrapped or marked in part reads as one", async () => {
    const saos = paragraphsOf(
      await saosDecision("pl-courts-detail-501501.json.gz"),
    ).join("\n");
    const gdansk = paragraphsOf(
      await saosDecision("pl-courts-detail-303939.json.gz"),
    ).join("\n");

    expect(saos).toContain("powodowie wskazali, że zawarli z pozwanym");
    expect(saos).toContain("bezwzględną nieważność umowy Sąd meriti bierze");
    expect(saos).toContain("jednak ze skutkiem ex tunc, a nie");
    expect(gdansk).toContain("przy współpracy z Biurami Powiatowymi.");
  });

  test("an article index is a superscript bound to its article", async () => {
    const indices = [
      ...superscriptsOf(await saosDecision("pl-courts-detail-501501.json.gz")),
      ...superscriptsOf(await saosDecision("pl-courts-detail-303939.json.gz")),
      ...superscriptsOf(
        await portalDecision(
          "152510000004021_VIII_U_002067_2016_Uz_2016-12-29_001",
        ),
      ),
    ];

    expect(indices).toContain("yśl art. 385^(1)");
    expect(indices).toContain(" do art. 353^1");
    expect(indices).toContain("epis art. 94^3");
    expect(indices).toContain("awie art.477^14");
    expect(indices.filter((index) => /\s$|\^\s/u.test(index))).toEqual([]);
  });

  test("a list item opens with its marker", async () => {
    const paragraphs = paragraphsOf(
      await saosDecision("pl-courts-detail-303939.json.gz"),
    );

    expect(
      paragraphs.some((paragraph) =>
        paragraph.startsWith("- akapit 2 strona 12 również przepisany"),
      ),
    ).toBe(true);
    expect(
      paragraphs.filter((paragraph) => /^[-–•]$/u.test(paragraph)),
    ).toEqual([]);
  });

  test("a numbered point keeps its number on its line", async () => {
    const paragraphs = paragraphsOf(
      await saosDecision("pl-courts-detail-303939.json.gz"),
    );

    expect(paragraphs).toContain("1. oddala apelację;");
  });

  test("a soft hyphen is where a word may break, not a character of it", async () => {
    for (const decision of await everyDecision()) {
      expect(decision.fulltext ?? "").not.toContain(SOFT_HYPHEN);
    }
    expect(
      (await saosDecision("pl-courts-detail-628.json.gz")).fulltext,
    ).toContain("Solidarną odpowiedzialność może ponosić");
  });

  test("reasons framed in a one-cell table are a heading and paragraphs", async () => {
    const decision = await portalDecision(
      "151005000004027_VIII_GC_000227_2021_Uz_2021-12-23_002",
    );
    const blocks = blocksOf(decision);

    expect(
      blocks.some(
        (block) =>
          block.type === "heading" && block.plainText === "UZASADNIENIE",
      ),
    ).toBe(true);
    expect(blocks.filter((block) => block.type === "table")).toEqual([]);
    const paragraphs = paragraphsOf(decision);
    expect(
      paragraphs.some((paragraph) => paragraph.startsWith("Powód (...) S.A.")),
    ).toBe(true);
    expect(
      paragraphs.some((paragraph) =>
        paragraph.startsWith(
          "a. ustawowymi odsetkami za opóźnienie w transakcjach handlowych od:",
        ),
      ),
    ).toBe(true);
  });

  test("reasons numbered on from the operative points are a heading, and the form's rows stay a table", async () => {
    const decision = await portalDecision(
      "151025200001006_II_K_000937_2025_Uz_2026-03-09_001",
    );
    const blocks = blocksOf(decision);
    const headings = blocks.flatMap((block) =>
      block.type === "heading" ? [block.plainText] : [],
    );

    expect(headings).toContain("V. UZASADNIENIE");
    expect(paragraphsOf(decision)).toContain("1. USTALENIE FAKTÓW");
    // A cell holding a column of paragraphs keeps one per line, never run
    // together and never spread across the row.
    const cells = blocks.flatMap((block) =>
      block.type === "table"
        ? block.rows.flatMap((row) => row.map((cell) => cell.plainText))
        : [],
    );
    expect(cells).toContain(
      "19-20, 79-79v, 251\n2-3 i 4-5\n205-209, 212-238\n48-49\n25",
    );
  });
});

const PLACEHOLDER = {
  type: TEXT_FIELD_TYPE.ABSENT,
  reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
};

describe("a common court's record without a thesis has none", () => {
  test.each([
    ["pl-courts-detail-summary-nietezowane.json.gz", "nietezowane"],
    ["pl-courts-detail-summary-brak.json.gz", "brak"],
  ])("SAOS's summary %s reads as absent", async (name, marker) => {
    const payload: unknown = JSON.parse(await fixture(name));
    const record = isRecord(payload) ? payload["data"] : undefined;
    expect(isRecord(record) ? record["summary"] : undefined).toBe(marker);

    const decision = await saosDecision(name);

    expect(decision.textFields.summary).toEqual(PLACEHOLDER);
  });

  test("the portal's thesis 'nietezowane' reads as absent", async () => {
    const id = "151515250002521_V_U_000097_2026_Uz_2026-05-04_001";
    const detailXml = await fixture(`pl-ncourt-detail-${id}.xml`);
    expect(detailXml).toContain("<thesis>nietezowane</thesis>");

    const outcome = assemblePlNcourtDecision({
      listingXml: `<judgement><id>${id}</id><signature>V U 97/26</signature><courtId>15151525</courtId><type>SENTENCE</type></judgement>`,
      detailXml,
      contentXml: undefined,
    });
    const decision =
      outcome.type === "built"
        ? outcome.decision
        : panic(`the record built ${outcome.type}`);

    expect(decision.textFields.headnote).toEqual(PLACEHOLDER);
  });
});
