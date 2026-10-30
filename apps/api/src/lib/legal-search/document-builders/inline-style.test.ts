import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import {
  inlineStyleDeclaresProperty,
  inlineStyleIsAsposeSpacer,
  inlineStyleIsBold,
  inlineStyleIsInlineBlock,
  inlineStyleIsItalic,
} from "./inline-style";

const element = (style?: string) => {
  const $ = cheerio.load("<span></span>");
  if (style !== undefined) {
    $("span").attr("style", style);
  }
  const node = $("span").get(0);
  if (node === undefined) {
    throw new Error("Missing fixture span");
  }
  return node;
};

const readers = [
  {
    name: "bold weight",
    read: inlineStyleIsBold,
    property: "font-weight",
    yes: "bold",
    no: "normal",
    positives: ["bold", "bolder", "600", "650.5", "1000", "6e2"],
    negatives: [
      "normal",
      "lighter",
      "599.9",
      "0",
      "1001",
      "boldish",
      "600px",
      "NaN",
      "Infinity",
    ],
  },
  {
    name: "italic style",
    read: inlineStyleIsItalic,
    property: "font-style",
    yes: "italic",
    no: "normal",
    positives: ["italic", "oblique"],
    negatives: ["normal", "italics", "italicized", "oblique-ish"],
  },
  {
    name: "Aspose spacer",
    read: inlineStyleIsAsposeSpacer,
    property: "-aw-import",
    yes: "ignore",
    no: "none",
    positives: ["ignore", "spaces"],
    negatives: ["none", "ignored", "spaceship"],
  },
  {
    name: "inline block",
    read: inlineStyleIsInlineBlock,
    property: "display",
    yes: "inline-block",
    no: "block",
    positives: ["inline-block", "inline flow-root", "flow-root  inline"],
    negatives: [
      "inline",
      "block",
      "none",
      "inline flow",
      "block flow-root",
      "inline-blocked",
      "inline-block extra",
    ],
  },
];

for (const { name, read, property, yes, no, positives, negatives } of readers) {
  describe(name, () => {
    test("accepts exact values with any declaration spacing and case", () => {
      for (const value of positives) {
        for (const gap of ["", " ", "\t\n"]) {
          expect(
            read(
              element(
                `${property.toUpperCase()}${gap}:${gap}${value.toUpperCase()}${gap};`,
              ),
            ),
          ).toBe(true);
        }
      }
    });

    test("rejects other values, other properties and absent declarations", () => {
      for (const value of negatives) {
        expect(read(element(`${property}:${value}`)), value).toBe(false);
      }
      for (const style of [
        undefined,
        "",
        property,
        `${property}:`,
        `other-${property}:${yes}`,
        `content:'${property}:${yes}'`,
      ]) {
        expect(read(element(style))).toBe(false);
      }
    });

    test("later declarations win at equal priority; important beats normal", () => {
      expect(read(element(`${property}:${yes}; ${property}:${no}`))).toBe(
        false,
      );
      expect(read(element(`${property}:${no}; ${property}:${yes}`))).toBe(true);
      expect(
        read(element(`${property}:${yes} ! IMPORTANT; ${property}:${no}`)),
      ).toBe(true);
      expect(
        read(element(`${property}:${no}!important; ${property}:${yes}`)),
      ).toBe(false);
      expect(
        read(
          element(`${property}:${yes}!important; ${property}:${no}!important`),
        ),
      ).toBe(false);
      expect(
        read(
          element(`${property}:${no}!important; ${property}:${yes}!important`),
        ),
      ).toBe(true);
      expect(read(element(`${property}:${yes}; ${property}:`))).toBe(true);
    });
  });
}

test("invalid declarations never override valid ones", () => {
  expect(
    inlineStyleIsBold(element("font-weight:bold; font-weight:600px!important")),
  ).toBe(true);
  expect(
    inlineStyleIsItalic(
      element("font-style:italic; font-style:italics!important"),
    ),
  ).toBe(true);
  expect(
    inlineStyleIsInlineBlock(
      element("display:inline-block; display:garbage!important"),
    ),
  ).toBe(true);
  expect(
    inlineStyleIsInlineBlock(
      element("display:inline-block; display:inline inline!important"),
    ),
  ).toBe(true);
  expect(
    inlineStyleDeclaresProperty(
      element("letter-spacing:garbage!important"),
      "letter-spacing",
    ),
  ).toBe(false);
});

test("an oblique angle is italic", () => {
  expect(inlineStyleIsItalic(element("font-style:oblique 10deg"))).toBe(true);
  expect(
    inlineStyleIsItalic(element("font-style:italic; font-style:oblique 10px")),
  ).toBe(true);
});

test("property presence accepts valid declarations rather than substrings", () => {
  const declaring = {
    "letter-spacing": ["normal", "0", "1px", "-0.5PT !IMPORTANT", "initial"],
    "-aw-headerfooter-type": ["header-primary", "footer !IMPORTANT"],
  } as const;
  for (const property of ["letter-spacing", "-aw-headerfooter-type"] as const) {
    for (const value of declaring[property]) {
      expect(
        inlineStyleDeclaresProperty(
          element(`${property.toUpperCase()} \t: ${value};`),
          property,
        ),
      ).toBe(true);
    }
    for (const style of [
      undefined,
      "",
      `${property}:`,
      `${property}:!important`,
      `other-${property}:1px`,
      `content:'${property}'`,
    ]) {
      expect(inlineStyleDeclaresProperty(element(style), property)).toBe(false);
    }
    expect(
      inlineStyleDeclaresProperty(
        element(`${property}:1px; ${property}:`),
        property,
      ),
    ).toBe(true);
  }
});

const nested = (html: string) => {
  const node = cheerio.load(html)("#target").get(0);
  if (node === undefined) {
    throw new Error("Missing fixture target");
  }
  return node;
};

describe("CSS-wide keywords", () => {
  test("initial resets an earlier declaration to normal", () => {
    expect(
      inlineStyleIsBold(element("font-weight:bold; font-weight:initial")),
    ).toBe(false);
    expect(
      inlineStyleIsItalic(element("font-style:italic; font-style:initial")),
    ).toBe(false);
  });

  test("importance decides between a value and a keyword", () => {
    expect(
      inlineStyleIsBold(
        element("font-weight:bold !important; font-weight:initial"),
      ),
    ).toBe(true);
    expect(
      inlineStyleIsBold(
        element("font-weight:bold; font-weight:initial !important"),
      ),
    ).toBe(false);
  });

  test("inherit and unset take the parent's computed value", () => {
    for (const keyword of ["inherit", "unset"]) {
      expect(
        inlineStyleIsBold(
          nested(
            `<span style="font-weight:bold"><span id="target" style="font-weight:normal; font-weight:${keyword}"></span></span>`,
          ),
        ),
      ).toBe(true);
      expect(
        inlineStyleIsBold(
          nested(
            `<span style="font-weight:normal"><span id="target" style="font-weight:bold; font-weight:${keyword}"></span></span>`,
          ),
        ),
      ).toBe(false);
      expect(
        inlineStyleIsItalic(
          nested(
            `<em><span id="target" style="font-style:normal; font-style:${keyword}"></span></em>`,
          ),
        ),
      ).toBe(true);
    }
  });

  test("revert falls back to the element's default style", () => {
    expect(
      inlineStyleIsBold(
        nested(
          '<b id="target" style="font-weight:normal; font-weight:revert"></b>',
        ),
      ),
    ).toBe(true);
    expect(
      inlineStyleIsBold(
        nested(
          '<span id="target" style="font-weight:bold; font-weight:revert"></span>',
        ),
      ),
    ).toBe(false);
    expect(
      inlineStyleIsItalic(
        nested(
          '<i id="target" style="font-style:normal; font-style:revert"></i>',
        ),
      ),
    ).toBe(true);
  });
});

describe("relative weights", () => {
  const bold = (parentStyle: string, ownStyle: string) =>
    inlineStyleIsBold(
      nested(
        `<span style="${parentStyle}"><span id="target" style="${ownStyle}"></span></span>`,
      ),
    );

  test("bolder steps up from the parent's computed weight", () => {
    expect(bold("font-weight:100", "font-weight:bolder")).toBe(false);
    expect(bold("font-weight:normal", "font-weight:bolder")).toBe(true);
    expect(bold("font-weight:600", "font-weight:bolder")).toBe(true);
  });

  test("lighter steps down from the parent's computed weight", () => {
    expect(bold("font-weight:900", "font-weight:lighter")).toBe(true);
    expect(bold("font-weight:bold", "font-weight:lighter")).toBe(false);
    expect(bold("font-weight:normal", "font-weight:lighter")).toBe(false);
  });

  test("a bold tag's default weight is bolder than its parent's", () => {
    expect(
      inlineStyleIsBold(
        nested(
          '<span style="font-weight:100"><b><span id="target" style="font-weight:inherit"></span></b></span>',
        ),
      ),
    ).toBe(false);
    expect(
      inlineStyleIsBold(
        nested('<b><span id="target" style="font-weight:inherit"></span></b>'),
      ),
    ).toBe(true);
  });
});
