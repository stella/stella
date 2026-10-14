import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";

import { COURTLISTENER_HTML_PARSERS, PAGE_CHROME_SIGNATURES } from "./html";
import { createTextBudget } from "./outcome";
import { selectOpinionText } from "./select";

const MENU_SIGNATURE = PAGE_CHROME_SIGNATURES.COURT_MENU;
const FOOTER_SIGNATURE = PAGE_CHROME_SIGNATURES.REPORTING_FOOTER;
const page = (content: string) => `<div>
Publisher page title
<div>Skip link</div><div><p>Publisher notice</p></div>
<nav>${MENU_SIGNATURE}</nav>
<main><h1>Invented opinion</h1><p>Invented court</p>${content}</main>
<footer>${FOOTER_SIGNATURE}</footer>
<div><p>Publisher cookie notice</p></div>
</div>`;

const parse = (text: string) =>
  COURTLISTENER_HTML_PARSERS.html({
    text,
    prefix: "invented",
    rowType: "020lead",
    budget: createTextBudget(),
  });
const blockTexts = (parsed: ReturnType<typeof parse>) =>
  parsed.status === "parsed"
    ? parsed.text.units.flatMap(({ blocks }) =>
        blocks.map(({ plainText }) => plainText),
      )
    : [];

test("an unproven aside retains its substantive footnote", () => {
  const parsed = parse(
    "<p>Judgment.</p><aside><p>1. Substantive footnote.</p></aside>",
  );
  expect(parsed.status).toBe("parsed");
  expect(blockTexts(parsed)).toEqual(["Judgment.", "1. Substantive footnote."]);
  if (parsed.status === "parsed") {
    expect(parsed.text.validationHtml).toContain("1. Substantive footnote.");
  }
});

test("an exhibit image in an unproven aside requires assets", () => {
  expect(
    parse(
      '<p>Judgment.</p><aside><img src="/invented-exhibit.png" alt="Exhibit"></aside>',
    ).status,
  ).toBe("requires-assets");
  for (const tag of ["header", "footer", "aside", "nav"]) {
    expect(
      parse(
        `<main><h1>Opinion</h1><p>Judgment.</p><${tag}><img src="/inside.png" alt="Exhibit"></${tag}></main>`,
      ).status,
    ).toBe("requires-assets");
    expect(
      parse(
        `<main><h1>Opinion</h1><p>Judgment.</p></main><${tag}><img src="/outside.png" alt="Exhibit"></${tag}>`,
      ).status,
    ).toBe("requires-assets");
  }
});

test("a substantive footer inside the opinion stays in document order", () => {
  const parsed = parse(
    `<header><nav>${MENU_SIGNATURE}</nav></header><main><h1>Opinion</h1><p>Judgment.</p><footer><p>Ordered by the court.</p></footer></main><footer>${FOOTER_SIGNATURE}</footer>`,
  );
  expect(parsed.status).toBe("parsed");
  expect(blockTexts(parsed)).toEqual([
    "Opinion",
    "Judgment.",
    "Ordered by the court.",
  ]);
});

test("a substantive footer outside the opinion root produces a typed hold", () => {
  const parsed = parse(
    "<main><h1>Opinion</h1><p>Judgment.</p></main><footer>Ordered by the court.</footer>",
  );
  expect(parsed).toMatchObject({
    status: "unusable",
    reason: "unclassified-page-chrome",
  });
});

test("an exhibit in a candidate footer is detected from the original body", () => {
  expect(
    parse(
      '<main><h1>Opinion</h1><p>Judgment.</p></main><footer><img src="/exhibit.png" alt="Exhibit"></footer>',
    ).status,
  ).toBe("requires-assets");
});

test("a reviewed publisher signature is removed while ordinary siblings remain", () => {
  const parsed = parse(page("<p>Invented ruling.</p><p>1 Invented note.</p>"));
  expect(parsed.status).toBe("parsed");
  expect(blockTexts(parsed)).toEqual([
    "Publisher page title",
    "Skip link",
    "Publisher notice",
    "Invented opinion",
    "Invented court",
    "Invented ruling.",
    "1 Invented note.",
    "Publisher cookie notice",
  ]);
  if (parsed.status === "parsed") {
    expect(parsed.text.validationHtml).not.toContain(FOOTER_SIGNATURE);
    expect(parsed.text.counts.publisherLinks).toBe(0);
  }
});

test("substantive images in ordinary siblings still require assets", () => {
  const image = '<img src="/invented-exhibit.png" alt="Invented chart">';
  for (const source of [
    page(`<p>Exhibit follows.</p>${image}`),
    page("<p>Ruling.</p>").replace(
      "<div>Skip link</div>",
      () => `<div>${image}</div>`,
    ),
    page("<p>Ruling.</p>").replace("Publisher cookie notice", () => image),
  ]) {
    expect(parse(source).status).toBe("requires-assets");
  }
});

test("heading-bearing roots do not scope away ordinary opinion siblings", () => {
  const parsed = parse(
    "<div><h1>Opinion</h1><p>Facts</p></div><div><p>The judgment is reversed.</p></div>",
  );
  expect(parsed.status).toBe("parsed");
  expect(blockTexts(parsed)).toContain("The judgment is reversed.");
});

test("a non-signature candidate outside the opinion root causes a hold", () => {
  const parsed = parse(
    `<main><h1>Opinion</h1><p>Judgment.</p></main><aside><nav>Sidebar links</nav><p>Publisher sidebar</p></aside>`,
  );
  expect(parsed).toMatchObject({
    status: "unusable",
    reason: "unclassified-page-chrome",
  });
});

test("unclassified document headers and footers outside the opinion require a hold", () => {
  const parsed = parse(
    "<header><h2>Invented parties</h2><p>Invented judge</p></header><main><h1>Judgment</h1><p>The judgment is reversed.</p></main><footer><p>Ordered by the court.</p></footer>",
  );
  expect(parsed).toMatchObject({
    status: "unusable",
    reason: "unclassified-page-chrome",
  });
});

test("nested document headers and footers are preserved inside opinion roots", () => {
  const parsed = parse(
    `<nav>${MENU_SIGNATURE}</nav><main><h1>Opinion</h1><header><h2>Invented court</h2><p>Invented judge</p></header><p>The judgment is reversed.</p><footer><p>Ordered by the court.</p></footer></main><footer>${FOOTER_SIGNATURE}</footer>`,
  );
  expect(parsed.status).toBe("parsed");
  expect(blockTexts(parsed)).toEqual([
    "Opinion",
    "Invented court",
    "Invented judge",
    "The judgment is reversed.",
    "Ordered by the court.",
  ]);
});

test("any unclassified candidate outside the opinion blocks plain-text fallback", () => {
  const selection = selectOpinionText({
    budget: createTextBudget(),
    row: opinionRow({
      xml_harvard: "",
      html_with_citations:
        '<main><h1>Opinion</h1><p>Judgment.</p></main><div role="navigation">Special legal instruction.</div>',
      plain_text: "Judgment.",
    }),
    type: "020lead",
  });
  expect(selection.status).toBe("no-usable-text");
  expect(selection.attempts).toContainEqual(
    expect.objectContaining({
      format: "html_with_citations",
      reason: "unclassified-page-chrome",
    }),
  );
});

test("generated candidate text is retained inside roots or held outside them", () => {
  assertProperty(
    "generated candidate text is retained inside roots or held outside them",
    fc.property(
      fc.constantFrom("header", "footer", "aside", "nav"),
      fc.stringMatching(/^[a-z]{4,30}$/u),
      fc.constantFrom("inside", "outside"),
      (tag, word, position) => {
        const candidate = `<${tag}><p>Substantive ${word} content.</p></${tag}>`;
        const source =
          position === "inside"
            ? `<main><h1>Opinion</h1>${candidate}<p>After.</p></main>`
            : `<main><h1>Opinion</h1><p>Judgment.</p></main>${candidate}`;
        const parsed = parse(
          `<header><nav>${MENU_SIGNATURE}</nav></header>${source}<footer>${FOOTER_SIGNATURE}</footer>`,
        );
        if (position === "inside") {
          expect(parsed.status).toBe("parsed");
          expect(blockTexts(parsed)).toContain(`Substantive ${word} content.`);
        } else {
          expect(parsed).toMatchObject({
            status: "unusable",
            reason: "unclassified-page-chrome",
          });
        }
      },
    ),
  );
});

test("every reviewed signature is removed only outside opinion roots", () => {
  for (const signature of Object.values(PAGE_CHROME_SIGNATURES)) {
    for (const tag of ["header", "footer", "aside", "nav"]) {
      const outside = parse(
        `<main><h1>Opinion</h1><p>Judgment.</p></main><${tag}>${signature}</${tag}>`,
      );
      expect(outside.status).toBe("parsed");
      expect(blockTexts(outside)).toEqual(["Opinion", "Judgment."]);
      const inside = parse(
        `<main><h1>Opinion</h1><${tag}>${signature}</${tag}><p>Judgment.</p></main>`,
      );
      expect(inside.status).toBe("parsed");
      expect(blockTexts(inside)).toContain(signature);
      expect(
        parse(
          `<main><h1>Opinion</h1><p>Judgment.</p></main><${tag}>${signature}<p>Additional legal instruction.</p></${tag}>`,
        ),
      ).toMatchObject({
        status: "unusable",
        reason: "unclassified-page-chrome",
      });
    }
  }
});

test("all explicit opinion roots protect their own candidate elements", () => {
  const parsed = parse(
    `<div class="opinion"><p>First ruling.</p></div><div class="opinion"><p>Second ruling.</p><footer><p>Ordered by the court.</p></footer></div>`,
  );
  expect(parsed.status).toBe("parsed");
  expect(blockTexts(parsed)).toEqual([
    "First ruling.",
    "Second ruling.",
    "Ordered by the court.",
  ]);
});

test("signature audit keeps inline words and rejects original note and page labels", () => {
  const inline = parse(
    `<main><h1>Opinion</h1><p>Judgment.</p></main><nav><span>Home Courts Deci</span><em>sions</em> Programs News Legal Research Court Records Quick Links</nav>`,
  );
  expect(inline.status).toBe("parsed");
  expect(blockTexts(inline)).toEqual(["Opinion", "Judgment."]);
  for (const label of ["<page-number>123</page-number>", "<sup>1</sup>"]) {
    expect(
      parse(
        `<main><h1>Opinion</h1><p>Judgment.</p></main><nav>${MENU_SIGNATURE}${label}</nav>`,
      ),
    ).toMatchObject({
      status: "unusable",
      reason: "unclassified-page-chrome",
    });
  }
});

test("implicit body opinions retain document captions with or without headings", () => {
  for (const caption of [
    "<header><h1>Invented parties</h1><h2>Invented docket</h2><p>Invented judge</p></header>",
    "<header><p>Invented parties</p><p>Invented docket</p><p>Invented judge</p></header>",
  ]) {
    const parsed = parse(
      `${caption}<h1>Judgment</h1><p>The judgment is reversed.</p><footer><p>Ordered by the court.</p></footer>`,
    );
    expect(parsed.status).toBe("parsed");
    expect(blockTexts(parsed)).toEqual([
      "Invented parties",
      "Invented docket",
      "Invented judge",
      "Judgment",
      "The judgment is reversed.",
      "Ordered by the court.",
    ]);
  }
});
