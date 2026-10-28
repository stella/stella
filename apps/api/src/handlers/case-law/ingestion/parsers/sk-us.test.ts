import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@stll/legal-ast/document-ast";
import { hasInlineChildren, plainTextOf } from "@stll/legal-ast/document-ast";

import { parseSkUsDocumentXhtml } from "@/api/handlers/case-law/ingestion/parsers/sk-us";
import { readGzipJson } from "@/api/lib/gzip-json";

const FIXTURES = new URL("../adapters/__fixtures__/", import.meta.url);

const parse = (xhtml: string) =>
  parseSkUsDocumentXhtml({
    xhtml,
    caseNumber: "PL. ÚS 11/2021",
    ecli: "ECLI:SK:USSR:2021:PL.US.11.2021.2",
    court: "Ústavný súd SR",
    decisionDate: "2021-07-29",
    decisionType: "uznesenie",
    documentUrl: "https://www.ustavnysud.sk/docDownload/75f2386e",
  });

/** Every inline of a document, flattened, so a test can look for one. */
const inlinesOf = (blocks: readonly Block[]): Inline[] => {
  const flat: Inline[] = [];
  const walk = (inlines: readonly Inline[]): void => {
    for (const inline of inlines) {
      flat.push(inline);
      if (hasInlineChildren(inline)) {
        walk(inline.children);
      }
    }
  };
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      walk(block.inlines);
    }
  }
  return flat;
};

const roleOf = (block: Block): string | undefined =>
  "role" in block ? block.role : undefined;

describe("the document the court renders as markup", () => {
  test("reads its parts from the words the court prints, not from tags", async () => {
    const payload = await readGzipJson(
      new URL("sk-us-content.json.gz", FIXTURES),
    );
    const content =
      typeof payload === "object" &&
      payload !== null &&
      "content" in payload &&
      typeof payload.content === "string"
        ? payload.content
        : "";
    const { documentAst, fulltext } = parse(
      Buffer.from(content, "base64").toString("utf-8"),
    );

    // There is no paragraph or heading element in the markup: every one of
    // these was read off the font size and the court's own section words,
    // spaced out as it prints them (`rozh od ol :`).
    const headings = documentAst.blocks.filter(
      (block) => block.type === "heading",
    );
    expect(headings.map((block) => block.plainText.trim())).toEqual([
      "OPRAVNÉ UZNESENIE",
      "rozh od ol :",
      "O d ôvod n eni e:",
    ]);
    expect(headings.at(0)).toMatchObject({ role: "decision-title" });
    expect(
      documentAst.blocks.filter((block) => roleOf(block) === "holding"),
    ).toHaveLength(2);
    expect(documentAst.blocks.map(roleOf)).toContain("closing");
    expect(documentAst.blocks.map(roleOf)).toContain("signature");
    // The page footer is the court's, not the decision's.
    expect(fulltext).not.toMatch(/^\s*2\s*$/mu);
  });

  test("a hidden run reaches neither the text nor the tree", () => {
    const secret = "Ján Novák, Hlavná 1, Košice";
    const { documentAst, fulltext } = parse(
      `<html><body><div><span style="font-size: 12px; ">Sťažovateľ <br/>` +
        `</span><span style="color: #000000; background-color: #000000; font-size: 12px; ">${secret}</span>` +
        `<span style="font-size: 12px; "> podal sťažnosť. <br/></span></div></body></html>`,
    );

    // The court paints anonymized text the colour of its own background. A
    // parser that read the span as text would publish what the court hid.
    expect(fulltext).not.toContain(secret);
    expect(JSON.stringify(documentAst)).not.toContain(secret);
    expect(JSON.stringify(documentAst)).not.toContain("Novák");
    // The gap is still stated: a reader has to see that something stood there.
    expect(
      inlinesOf(documentAst.blocks).some(
        (inline) => inline.type === "text" && inline.anonymized === true,
      ),
    ).toBe(true);
  });

  test("the run the court actually hides carries no words at all", () => {
    const { fulltext } = parse(
      `<html><body><div><span style="font-size: 12px; ">Sťažovateľ <br/>` +
        `</span><span style="color: #000000; background-color: #000000; font-size: 12px; ">${"&nbsp;".repeat(
          40,
        )}</span>` +
        `<span style="font-size: 12px; "> podal sťažnosť. <br/></span></div></body></html>`,
    );

    // Verified against the live service: the hidden span is a run of
    // non-breaking spaces, so what it replaces is gone rather than hidden.
    // Kept out of the text anyway: forty spaces are not something the
    // decision says.
    expect(fulltext).not.toMatch(/\u00a0{4}/u);
    expect(fulltext).toContain("podal sťažnosť.");
  });

  test("keeps body text outside spans, including paragraphs and table cells", () => {
    const { documentAst, fulltext } = parse(
      "<html><body>Voľný úvod.<p>Text odseku.</p>" +
        "<table><tr><td>Text bunky A.</td><td><span>Text bunky B.</span></td></tr></table>" +
        "Voľný záver.</body></html>",
    );

    for (const text of [
      "Voľný úvod.",
      "Text odseku.",
      "Text bunky A.",
      "Text bunky B.",
      "Voľný záver.",
    ]) {
      expect(fulltext).toContain(text);
      expect(JSON.stringify(documentAst)).toContain(text);
    }
  });
});

test("one-line Roman titles enter the outline without swallowing the following paragraph", () => {
  const { documentAst } = parse(
    "<html><body><span>Odôvodnenie:<br/>I. Ústavná sťažnosť<br/>Text odôvodnenia.<br/>II. A) Argumentácia<br/>Ďalší text.<br/></span></body></html>",
  );
  const headings = documentAst.blocks.filter(
    (block) => block.type === "heading",
  );
  expect(headings.map((block) => [block.plainText, block.level])).toEqual([
    ["Odôvodnenie:", 2],
    ["I. Ústavná sťažnosť", 3],
    ["II. A) Argumentácia", 4],
  ]);
  expect(
    documentAst.blocks
      .filter((block) => block.type === "paragraph")
      .map((block) => block.plainText),
  ).toEqual(["Text odôvodnenia.", "Ďalší text."]);
});

test("Roman verdict items keep their holding role while reasoning titles enter the outline", () => {
  const verdict = "I. Súd žalobu zamieta.";
  const { documentAst } = parse(
    `<html><body><span>rozhodol:<br/>${verdict}<br/>II. Náhradu nepriznáva.<br/>Odôvodnenie:<br/>I. Ústavná sťažnosť<br/>Text odôvodnenia.<br/></span></body></html>`,
  );
  expect(
    documentAst.blocks.find((block) => block.plainText.includes(verdict)),
  ).toMatchObject({ type: "paragraph", role: "holding" });
  expect(
    documentAst.blocks.find(
      (block) => block.plainText === "I. Ústavná sťažnosť",
    ),
  ).toMatchObject({ type: "heading", level: 3 });
  expect(
    documentAst.blocks
      .filter((block) => block.type === "heading")
      .map((block) => block.plainText),
  ).not.toContain(verdict);
});

describe("numbered reasoning set without blank lines", () => {
  const reasoning = (lines: readonly string[]) =>
    parse(
      `<html><body><div><span style="font-size: 12px; ">O d ôvod n eni e : <br/><br/>${lines
        .map((line) => `${line} <br/>`)
        .join("\n")}<br/></span></div></body></html>`,
    ).documentAst.blocks.filter(
      (block) => block.type === "paragraph" && block.role === undefined,
    );

  test("the court's next number on a new line starts the next paragraph", () => {
    const blocks = reasoning([
      "1. Sťažovateľ sa ústavnou sťažnosťou doručenou ústavnému súdu",
      "domáha ochrany osobnosti.",
      "2. Sudca spravodajca oznámil, že sa dozvedel o komunikácii.",
      "3. Sťažovateľ vzniesol námietku zaujatosti.",
    ]);
    expect(
      blocks.map((block) => [
        block.type === "paragraph" ? block.number : null,
        block.plainText,
      ]),
    ).toEqual([
      [
        1,
        "Sťažovateľ sa ústavnou sťažnosťou doručenou ústavnému súdu domáha ochrany osobnosti.",
      ],
      [2, "Sudca spravodajca oznámil, že sa dozvedel o komunikácii."],
      [3, "Sťažovateľ vzniesol námietku zaujatosti."],
    ]);
    // The inlines read exactly as the text, joined lines included.
    expect(
      blocks.map((block) =>
        block.type === "paragraph" ? plainTextOf(block.inlines) : null,
      ),
    ).toEqual(blocks.map((block) => block.plainText));
  });

  test("a number the court skipped still starts its paragraph", () => {
    const blocks = reasoning([
      "1. Sťažovateľ podal ústavnú sťažnosť.",
      "3. Sudca spravodajca oznámil námietku.",
      "4. Námietka nie je dôvodná.",
    ]);
    expect(
      blocks.map((block) => [
        block.type === "paragraph" ? block.number : null,
        block.plainText,
      ]),
    ).toEqual([
      [1, "Sťažovateľ podal ústavnú sťažnosť."],
      [3, "Sudca spravodajca oznámil námietku."],
      [4, "Námietka nie je dôvodná."],
    ]);
  });

  test("a quoted petit's own points do not split the paragraph quoting it", () => {
    const blocks = reasoning([
      "1. Sťažovateľ navrhuje, aby ústavný súd rozhodol takto:",
      "„1. Základné právo sťažovateľa podľa čl. 46 ods. 1 ústavy bolo porušené.",
      "2. Napadnuté uznesenie sa zrušuje.“",
      "2. Sudca spravodajca oznámil námietku.",
    ]);
    expect(blocks.map((block) => block.plainText)).toEqual([
      "Sťažovateľ navrhuje, aby ústavný súd rozhodol takto: „1. Základné právo sťažovateľa podľa čl. 46 ods. 1 ústavy bolo porušené. 2. Napadnuté uznesenie sa zrušuje.“",
      "Sudca spravodajca oznámil námietku.",
    ]);
  });

  test("a petit point that repeats the court's next number later is not its paragraph", () => {
    const blocks = reasoning([
      "1. Sťažovateľ navrhuje, aby ústavný súd rozhodol takto:",
      "1. Základné právo sťažovateľa bolo porušené.",
      "2. Napadnuté uznesenie sa zrušuje.",
      "2. Sudca spravodajca oznámil námietku.",
    ]);
    expect(blocks.map((block) => block.plainText)).toEqual([
      "Sťažovateľ navrhuje, aby ústavný súd rozhodol takto: 1. Základné právo sťažovateľa bolo porušené. 2. Napadnuté uznesenie sa zrušuje.",
      "Sudca spravodajca oznámil námietku.",
    ]);
  });

  test("a quoted point repeating the court's number later does not merge the court's paragraph", () => {
    const blocks = reasoning([
      "1. Sťažovateľ podal ústavnú sťažnosť.",
      "2. Sudca spravodajca oznámil námietku.",
      "3. Sťažovateľ navrhol: „1. Základné právo bolo porušené.",
      "2. Napadnuté uznesenie sa zrušuje.“",
      "4. Námietka nie je dôvodná.",
    ]);
    expect(
      blocks.map((block) => [
        block.type === "paragraph" ? block.number : null,
        block.plainText,
      ]),
    ).toEqual([
      [1, "Sťažovateľ podal ústavnú sťažnosť."],
      [2, "Sudca spravodajca oznámil námietku."],
      [
        3,
        "Sťažovateľ navrhol: „1. Základné právo bolo porušené. 2. Napadnuté uznesenie sa zrušuje.“",
      ],
      [4, "Námietka nie je dôvodná."],
    ]);
  });

  test("a list later in the reasoning repeating the court's number does not merge the court's paragraph", () => {
    const blocks = reasoning([
      "1. Sťažovateľ podal ústavnú sťažnosť.",
      "2. Sudca spravodajca oznámil námietku.",
      "3. Ústavný súd zistil tieto skutočnosti.",
      "1. Prvá skutočnosť je nesporná.",
      "2. Druhá skutočnosť je nesporná.",
      "4. Námietka nie je dôvodná.",
    ]);
    expect(
      blocks.map((block) => [
        block.type === "paragraph" ? block.number : null,
        block.plainText,
      ]),
    ).toEqual([
      [1, "Sťažovateľ podal ústavnú sťažnosť."],
      [2, "Sudca spravodajca oznámil námietku."],
      [
        3,
        "Ústavný súd zistil tieto skutočnosti. 1. Prvá skutočnosť je nesporná. 2. Druhá skutočnosť je nesporná.",
      ],
      [4, "Námietka nie je dôvodná."],
    ]);
  });

  test("a line ending in an abbreviation's number or a lettered point is not a sentence end", () => {
    for (const ending of [
      "podľa § 49 ods. 1",
      "uvedené pod č. 2",
      "podľa písm. a)",
      "rozhodol takto:",
    ]) {
      const blocks = reasoning([
        `1. Sťažovateľ namieta porušenie práva ${ending}`,
        "2. Februárom sa lehota skončila.",
      ]);
      expect({ ending, count: blocks.length }).toEqual({ ending, count: 1 });
    }
  });

  test("a date wrapped to the start of a line does not split a sentence", () => {
    const blocks = reasoning([
      "1. Sťažovateľ podal ústavnú sťažnosť dňa",
      "2. februára 2026 a domáha sa ochrany.",
      "2. Sudca spravodajca oznámil námietku.",
    ]);
    expect(blocks.map((block) => block.plainText)).toEqual([
      "Sťažovateľ podal ústavnú sťažnosť dňa 2. februára 2026 a domáha sa ochrany.",
      "Sudca spravodajca oznámil námietku.",
    ]);
  });
});

describe("page numbers the markup keeps", () => {
  /** The court's markup: one span, a `<br/>` after every printed line. */
  const markup = (lines: readonly string[]) =>
    parse(
      `<html><body><div><span style="font-size: 12px; ">${lines
        .map((line) => `${line}<br/>`)
        .join("\n")}</span></div></body></html>`,
    ).documentAst.blocks;
  const texts = (lines: readonly string[]) =>
    markup(lines).flatMap((block) =>
      block.type === "paragraph" || block.type === "heading"
        ? [block.plainText]
        : [],
    );
  /** A page's worth of prose: about 1,500 characters in 20 lines. */
  const page = (label: string) =>
    Array.from(
      { length: 20 },
      (_, line) =>
        `${label} ${line} pokračuje ďalej a opisuje priebeh konania pred súdom,`,
    );

  test.each([
    ["an amount", "2 eurá."],
    ["a docket", "5 Cdo 12/2020 rozhodol."],
    ["a paragraph number", "2. Sťažovateľ podal sťažnosť."],
  ])(
    "a number opening a line after a blank line keeps it when no page sequence confirms it: %s",
    (_, line) => {
      expect(
        texts(["O d ô v o d n e n i e :", "", "Zostáva zaplatiť", "", line]),
      ).toEqual(["Odôvodnenie:", "Zostáva zaplatiť", line]);
    },
  );

  test("numbers glued to body lines a page apart do not vouch for each other", () => {
    for (const [third, fourth] of [
      ["3 eurá.", "4 eurá."],
      ["3 Ďalšie odôvodnenie.", "4 Ďalšie odôvodnenie."],
    ] as const) {
      const paragraphs = texts([
        "Odôvodnenie:",
        "Text odôvodnenia. ".repeat(130),
        "",
        third,
        "Text odôvodnenia. ".repeat(70),
        "",
        fourth,
      ]);
      expect(paragraphs.some((text) => text.startsWith(third))).toBe(true);
      expect(paragraphs.at(-1)).toBe(fourth);
    }
  });

  test("an amount where a page's number is due keeps its number, and the pages stay unproven", () => {
    const paragraphs = texts([
      "O d ô v o d n e n i e :",
      "",
      ...page("Prvá strana"),
      "",
      "2",
      "",
      ...page("Druhá strana"),
      "",
      "3 eurá za každý deň omeškania.",
      ...page("Tretia strana"),
      "",
      "4",
    ]);
    expect(
      paragraphs.some((text) =>
        text.startsWith("3 eurá za každý deň omeškania."),
      ),
    ).toBe(true);
  });

  test("an amount on a page of a numbered document is not that page's number", () => {
    const paragraphs = texts([
      "O d ô v o d n e n i e :",
      "",
      ...page("Prvá strana"),
      "Zostáva zaplatiť",
      "",
      "2 eurá za každý deň omeškania.",
      ...page("Ešte prvá strana"),
      "",
      "2 strana sa začína tu.",
      ...page("Druhá strana"),
      "",
      "3 Tretia strana sa začína tu.",
      ...page("Tretia strana"),
      "",
      "4",
    ]);
    expect(
      paragraphs.some((text) =>
        text.startsWith("2 eurá za každý deň omeškania."),
      ),
    ).toBe(true);
    // The page sequence still reads: both pages go on with the sentence the
    // page before cut, their numbers gone.
    for (const opening of [
      "strana sa začína tu.",
      "Tretia strana sa začína tu.",
    ]) {
      expect(
        paragraphs.some((text) => text.includes(`pred súdom, ${opening}`)),
      ).toBe(true);
    }
  });

  test("a standalone footer after a part title stays out of the heading", () => {
    const blocks = markup([
      "Odôvodnenie:",
      "",
      "I.",
      ...page("Prvá strana"),
      "Predchádzajúca časť skončila.",
      "",
      "II.",
      "Argumentácia",
      "2",
      "",
      "1. Nový odsek.",
      ...page("Druhá strana"),
      "",
      "3",
    ]);
    const headings = blocks.flatMap((block) =>
      block.type === "heading" ? [block.plainText] : [],
    );
    expect(headings).toContain("II. Argumentácia");
    expect(headings).not.toContain("II. Argumentácia 2");
  });

  test("a page number on a line of its own does not join a part heading to the page before", () => {
    const blocks = markup([
      "O d ô v o d n e n i e :",
      "",
      "I.",
      ...page("Prvá strana"),
      "Text predchádzajúcej časti",
      "",
      "2",
      "II. Argumentácia",
      "",
      "Nový odsek.",
      ...page("Druhá strana"),
      "",
      "3",
    ]);
    const headings = blocks.flatMap((block) =>
      block.type === "heading" ? [block.plainText] : [],
    );
    expect(headings).toContain("II. Argumentácia");
    expect(
      blocks.some(
        (block) =>
          block.type === "paragraph" &&
          block.plainText.endsWith("Text predchádzajúcej časti"),
      ),
    ).toBe(true);
  });
});

describe("letter spacing across inline boundaries", () => {
  // The same text in every case, its spans cut at different places: a span's
  // edge is not a gap between words.
  test.each([
    ["one span", ["Podanie bolo doručené k elektronickému podaniu."]],
    [
      "the short word on its own",
      ["Podanie bolo doručené ", "k e", "lektronickému podaniu."],
    ],
    [
      "split inside the word",
      ["Podanie bolo doručené k e", "lektro", "nickému podaniu."],
    ],
  ])("%s", (_, runs) => {
    const { documentAst } = parse(
      `<html><body><div>${runs
        .map((run) => `<span style="font-size: 12px; ">${run}</span>`)
        .join("")}</div></body></html>`,
    );
    expect(
      documentAst.blocks.flatMap((block) =>
        block.type === "paragraph" ? [block.plainText] : [],
      ),
    ).toEqual(["Podanie bolo doručené k elektronickému podaniu."]);
  });
});
