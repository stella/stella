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

test("full publisher pages read the complete captioned document subtree", () => {
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
    "Invented opinion",
    "Invented court",
    "Invented ruling.",
    "1 Invented note.",
  ]);
  expect(parsed.text.validationHtml).not.toContain("Publisher");
  expect(parsed.text.counts.publisherLinks).toBe(0);
});

test("document images and ambiguous publisher pages still require assets", () => {
  const image = '<img src="/invented-exhibit.png" alt="Invented chart">';
  for (const source of [
    page(`<p>Exhibit follows.</p>${image}`),
    page("<p>Ruling.</p>")
      .replace("<footer>", "<div>")
      .replace("</footer>", "</div>"),
    page("<h1>Another possible document</h1><p>Ruling.</p>"),
    page("<p>Ruling.</p>").replace(
      "</div>\n<div><footer>",
      "</div><div><h1>Another document</h1></div>\n<div><footer>",
    ),
  ]) {
    expect(parse(source).status).toBe("requires-assets");
  }
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
        const content = paragraphs.map((text) => `<p>${text}</p>`).join("");
        const parsed = parse(page(content));
        expect(parsed.status).toBe("parsed");
        if (parsed.status !== "parsed") {
          return;
        }
        expect(
          parsed.text.units.flatMap(({ blocks }) =>
            blocks.map(({ plainText }) => plainText),
          ),
        ).toEqual(["Invented opinion", "Invented court", ...paragraphs]);
        expect(
          parse(page(`${content}<img src="/invented-exhibit.png" alt="">`))
            .status,
        ).toBe("requires-assets");
      },
    ),
  );
});
