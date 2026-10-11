import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { COURTLISTENER_HTML_PARSERS } from "./html";
import { createTextBudget } from "./outcome";

const page = (content: string) => `<div>
Publisher page title
<div>Skip link</div><div><p>Publisher notice</p></div>
<div><header><img src="/invented-logo.svg" alt=""><nav>Menu</nav></header></div>
<nav>Breadcrumb</nav>
<div><div><h1>Invented opinion</h1><p>Invented court</p></div>${content}</div>
<div><footer><p>Publisher footer</p><a href="/privacy">Privacy</a></footer></div>
<div><p>Publisher cookie notice</p></div>
</div>`;

const parse = (text: string) =>
  COURTLISTENER_HTML_PARSERS.html({
    text,
    prefix: "invented",
    rowType: "020lead",
    budget: createTextBudget(),
  });

test("an unproven aside retains its substantive footnote", () => {
  const parsed = parse(
    "<p>Judgment.</p><aside><p>1. Substantive footnote.</p></aside>",
  );
  expect(parsed.status).toBe("parsed");
  if (parsed.status !== "parsed") {
    return;
  }
  expect(
    parsed.text.units.flatMap(({ blocks }) =>
      blocks.map(({ plainText }) => plainText),
    ),
  ).toEqual(["Judgment.", "1. Substantive footnote."]);
  expect(parsed.text.validationHtml).toContain("1. Substantive footnote.");
});

test("an exhibit image in an unproven aside requires assets", () => {
  expect(
    parse(
      '<p>Judgment.</p><aside><img src="/invented-exhibit.png" alt="Exhibit"></aside>',
    ).status,
  ).toBe("requires-assets");
});

test("page evidence identifies a navigation aside while preserving substantive siblings", () => {
  const parsed = parse(
    page(
      '<aside><nav>Sidebar links</nav><p>Publisher sidebar</p><img src="/invented-logo.svg" alt=""></aside><aside><p>Substantive note.</p></aside>',
    ),
  );
  expect(parsed.status).toBe("parsed");
  if (parsed.status !== "parsed") {
    return;
  }
  const text = parsed.text.units.flatMap(({ blocks }) =>
    blocks.map(({ plainText }) => plainText),
  );
  expect(text).toContain("Substantive note.");
  expect(text).not.toContain("Publisher sidebar");
  expect(parsed.text.validationHtml).toContain("Substantive note.");
  expect(parsed.text.validationHtml).not.toContain("Publisher sidebar");
});

test("every generated substantive aside is conserved", () => {
  assertProperty(
    "every generated substantive aside is conserved",
    fc.property(
      fc.array(fc.stringMatching(/^[a-z]{4,30}$/u), {
        minLength: 1,
        maxLength: 30,
      }),
      (words) => {
        const paragraphs = words.map((word) => `Substantive ${word} note.`);
        const parsed = parse(
          `<p>Judgment.</p>${paragraphs.map((text) => `<aside><p>${text}</p></aside>`).join("")}`,
        );
        expect(parsed.status).toBe("parsed");
        if (parsed.status !== "parsed") {
          return;
        }
        expect(
          parsed.text.units.flatMap(({ blocks }) =>
            blocks.map(({ plainText }) => plainText),
          ),
        ).toEqual(["Judgment.", ...paragraphs]);
        for (const paragraph of paragraphs) {
          expect(parsed.text.validationHtml).toContain(paragraph);
        }
      },
    ),
  );
});

test("full publisher pages retain unclassified content in document order", () => {
  const parsed = parse(page("<p>Invented ruling.</p><p>1 Invented note.</p>"));
  expect(parsed.status).toBe("parsed");
  if (parsed.status !== "parsed") {
    return;
  }
  expect(
    parsed.text.units.flatMap(({ blocks }) =>
      blocks.map(({ plainText }) => plainText),
    ),
  ).toEqual([
    "Publisher page title",
    "Skip link",
    "Publisher notice",
    "Invented opinion",
    "Invented court",
    "Invented ruling.",
    "1 Invented note.",
    "Publisher cookie notice",
  ]);
  expect(parsed.text.validationHtml).not.toContain("Publisher footer");
  expect(parsed.text.counts.publisherLinks).toBe(0);
});

test("substantive images in any unclassified sibling still require assets", () => {
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

test("heading-bearing children do not scope away unclassified siblings", () => {
  const parsed = parse(
    "<div><header>Header</header><div><h1>Opinion</h1><p>Facts</p></div><div><p>The judgment is reversed.</p></div><footer>Footer</footer></div>",
  );
  expect(parsed.status).toBe("parsed");
  if (parsed.status !== "parsed") {
    return;
  }
  expect(
    parsed.text.units.flatMap(({ blocks }) =>
      blocks.map(({ plainText }) => plainText),
    ),
  ).toEqual([
    "Header",
    "Opinion",
    "Facts",
    "The judgment is reversed.",
    "Footer",
  ]);
  expect(parsed.text.validationHtml).toContain("The judgment is reversed.");
});

test("document headers and footers remain when page furniture is unproven", () => {
  for (const caption of [
    "<header><h1>Invented parties</h1><h2>Invented docket</h2><p>Invented judge</p></header>",
    "<header><p>Invented parties</p><p>Invented docket</p><p>Invented judge</p></header>",
  ]) {
    const parsed = parse(
      `${caption}<h1>Judgment</h1><p>The judgment is reversed.</p><footer><p>Ordered by the court.</p></footer>`,
    );
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed") {
      continue;
    }
    expect(
      parsed.text.units.flatMap(({ blocks }) =>
        blocks.map(({ plainText }) => plainText),
      ),
    ).toEqual([
      "Invented parties",
      "Invented docket",
      "Invented judge",
      "Judgment",
      "The judgment is reversed.",
      "Ordered by the court.",
    ]);
    expect(parsed.text.validationHtml).toContain("Invented judge");
    expect(parsed.text.validationHtml).toContain("Ordered by the court.");
  }
});

test("page furniture evidence does not discard a document header containing headings", () => {
  const parsed = parse(
    "<div><header><nav>Menu</nav></header><div><h1>Opinion</h1><header><h2>Invented court</h2><p>Invented judge</p></header><p>The judgment is reversed.</p></div><footer>Publisher footer</footer></div>",
  );
  expect(parsed.status).toBe("parsed");
  if (parsed.status !== "parsed") {
    return;
  }
  expect(
    parsed.text.units.flatMap(({ blocks }) =>
      blocks.map(({ plainText }) => plainText),
    ),
  ).toEqual([
    "Opinion",
    "Invented court",
    "Invented judge",
    "The judgment is reversed.",
  ]);
});

test("publisher furniture scope conserves every generated opinion paragraph", () => {
  assertProperty(
    "publisher furniture scope conserves every generated opinion paragraph",
    fc.property(
      fc.array(fc.stringMatching(/^[a-z]{4,30}$/u), {
        minLength: 1,
        maxLength: 30,
      }),
      (words) => {
        const paragraphs = words.map((word) => `Invented ${word} content.`);
        const content = paragraphs
          .map(
            (text) =>
              `<div><p>${text}</p><aside><nav>Excluded sidebar</nav></aside></div>`,
          )
          .join("");
        const source = `<div><header><nav>Header menu</nav>Header</header><div><p>Before caption.</p><nav>Nested menu</nav></div><div><h1>Opinion</h1><p>Facts</p><section><footer>Nested footer</footer><p>Nested content.</p></section></div>${content}<footer>Footer</footer></div>`;
        const parsed = parse(source);
        expect(parsed.status).toBe("parsed");
        if (parsed.status !== "parsed") {
          return;
        }
        expect(
          parsed.text.units.flatMap(({ blocks }) =>
            blocks.map(({ plainText }) => plainText),
          ),
        ).toEqual([
          "Before caption.",
          "Opinion",
          "Facts",
          "Nested content.",
          ...paragraphs,
        ]);
        for (const text of [
          "Before caption.",
          "Nested content.",
          ...paragraphs,
        ]) {
          expect(parsed.text.validationHtml).toContain(text);
        }
        expect(parsed.text.validationHtml).not.toContain("Excluded sidebar");
        expect(parsed.text.validationHtml).not.toContain("Nested menu");
        expect(parsed.text.validationHtml).not.toContain("Nested footer");
        expect(
          parse(page(`${content}<img src="/invented-exhibit.png" alt="">`))
            .status,
        ).toBe("requires-assets");
      },
    ),
  );
});
