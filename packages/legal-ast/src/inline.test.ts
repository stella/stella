import { describe, expect, test } from "bun:test";

import { parseDocumentAst, plainTextOf } from "./document-ast";
import {
  flattenInlineText,
  hasInlineChildren,
  isInline,
  isInlineArray,
} from "./inline";
import type { Inline } from "./inline";

/**
 * One sample per declared inline kind.
 *
 * Total over `Inline["type"]`, so a kind added to the union without a
 * sample is a type error. The tests then run every sample through both
 * readers, which is what binds the strict schema to its persisted
 * counterpart: a kind the persisted reader has no branch for would be
 * read as unrecognised and degraded to plain text, and the round trip
 * below fails on exactly that.
 */
const SAMPLES = {
  text: { type: "text", text: "Article " },
  "line-break": { type: "line-break" },
  "page-anchor": { type: "page-anchor", label: "495" },
  bold: { type: "bold", children: [{ type: "text", text: "5" }] },
  italic: { type: "italic", children: [{ type: "text", text: "obiter" }] },
  underline: { type: "underline", children: [{ type: "text", text: "not" }] },
  superscript: { type: "superscript", children: [{ type: "text", text: "3" }] },
  subscript: { type: "subscript", children: [{ type: "text", text: "2" }] },
  link: {
    type: "link",
    href: "#art-5",
    children: [{ type: "text", text: "ref" }],
  },
  citation: {
    type: "citation",
    cite: "Rep. 2019, 412",
    href: "https://reports.test/2019/412",
    children: [{ type: "text", text: "the earlier case" }],
    target: {
      status: "identified",
      identifiers: [{ type: "reporter-citation", value: "347 U.S. 483" }],
    },
    pin: {
      raw: "495–97 & n. 12",
      parts: [
        { kind: "page", start: "495", end: "97" },
        { kind: "footnote", start: "12" },
      ],
      reporter: { type: "reporter-citation", value: "347 U.S. 483" },
    },
  },
} satisfies Record<Inline["type"], Inline>;

const EVERY_KIND: Inline[] = Object.values(SAMPLES);

describe("inline AST", () => {
  test("validates and flattens nested inline content", () => {
    const inlines: Inline[] = [
      { type: "text", text: "Article " },
      { type: "bold", children: [{ type: "text", text: "5" }] },
      { type: "line-break" },
      {
        type: "link",
        href: "#art-5",
        children: [
          { type: "italic", children: [{ type: "text", text: "ref" }] },
        ],
      },
    ];

    expect(isInlineArray(inlines)).toBe(true);
    expect(flattenInlineText(inlines)).toBe("Article 5\nref");
  });

  test("every declared kind is accepted by the canonical guard", () => {
    for (const sample of EVERY_KIND) {
      expect(isInline(sample)).toBe(true);
    }
    expect(isInlineArray(EVERY_KIND)).toBe(true);
  });

  test("the kinds that nest children are exactly the ones that carry them", () => {
    for (const sample of EVERY_KIND) {
      expect(hasInlineChildren(sample)).toBe("children" in sample);
    }
  });

  test("every declared kind survives the persisted reader unchanged", () => {
    const parsed = parseDocumentAst({
      version: 1,
      blocks: [
        { id: "p1", anchorId: "p-1", type: "paragraph", inlines: EVERY_KIND },
      ],
    });
    const block = parsed?.blocks.at(0);
    expect(block?.type === "paragraph" ? block.inlines : null).toEqual(
      EVERY_KIND,
    );
  });
});

describe("text axis", () => {
  test("a citation contributes its children, never its printed cite", () => {
    expect(plainTextOf([SAMPLES.citation])).toBe("the earlier case");
    expect(flattenInlineText([SAMPLES.citation])).toBe("the earlier case");
  });

  test("superscript, subscript and underline contribute their children", () => {
    expect(
      plainTextOf([SAMPLES.superscript, SAMPLES.subscript, SAMPLES.underline]),
    ).toBe("32not");
  });

  test("a page anchor still contributes nothing", () => {
    expect(plainTextOf([SAMPLES["page-anchor"]])).toBe("");
  });
});

describe("citation", () => {
  test("requires the reference as the publisher printed it", () => {
    expect(isInline({ ...SAMPLES.citation, cite: "" })).toBe(false);
  });

  test("is valid without a link: not every printed reference has one", () => {
    const { href: _href, ...unlinked } = SAMPLES.citation;
    expect(isInline(unlinked)).toBe(true);
  });
});

/** Whether both readers accept one citation inline. */
const readers = (citation: unknown) => ({
  canonical: isInline(citation),
  persisted:
    parseDocumentAst({
      version: 1,
      blocks: [
        { id: "p1", anchorId: "p-1", type: "paragraph", inlines: [citation] },
      ],
    }) !== null,
});

const persistedCitation = (citation: unknown): unknown => {
  const block = parseDocumentAst({
    version: 1,
    blocks: [
      { id: "p1", anchorId: "p-1", type: "paragraph", inlines: [citation] },
    ],
  })?.blocks.at(0);
  return block?.type === "paragraph" ? block.inlines.at(0) : undefined;
};

describe("citation target and pin", () => {
  const { pin: _pin, target: _target, ...plain } = SAMPLES.citation;

  test("a citation written before either field decodes without them", () => {
    const decoded = persistedCitation(plain);
    expect(decoded).toEqual(plain);
    expect(Object.keys(decoded ?? {}).toSorted()).toEqual(
      Object.keys(plain).toSorted(),
    );
  });

  test("an unresolved target carries no identifiers", () => {
    const unresolved = {
      ...plain,
      target: { status: "unresolved", reason: "missing-antecedent" },
    };
    expect(readers(unresolved)).toEqual({ canonical: true, persisted: true });
    expect(
      readers({
        ...plain,
        target: {
          status: "unresolved",
          reason: "missing-antecedent",
          identifiers: SAMPLES.citation.target.identifiers,
        },
      }),
    ).toEqual({ canonical: false, persisted: false });
  });

  const reporter = { type: "reporter-citation", value: "347 U.S. 483" };
  const malformed = {
    "no identifiers": {
      target: { status: "identified", identifiers: [] },
    },
    "too many identifiers": {
      target: {
        status: "identified",
        identifiers: Array.from({ length: 33 }, (_, index) => ({
          type: "reporter-citation",
          value: `${String(index + 1)} U.S. 1`,
        })),
      },
    },
    "an unknown reason": {
      target: { status: "unresolved", reason: "guessed" },
    },
    "a letter in a page": {
      pin: { raw: "49a", parts: [{ kind: "page", start: "49a" }] },
    },
    "an empty raw pin": {
      pin: { raw: "", parts: [{ kind: "page", start: "495" }] },
    },
    "an overlong raw pin": {
      pin: { raw: "4".repeat(129), parts: [{ kind: "page", start: "4" }] },
    },
    "no parts": { pin: { raw: "495", parts: [] } },
    "nine parts": {
      pin: {
        raw: "1, 2, 3, 4, 5, 6, 7, 8, 9",
        parts: Array.from({ length: 9 }, (_, index) => ({
          kind: "page",
          start: String(index + 1),
        })),
      },
    },
    "an undeclared key in a part": {
      pin: { raw: "495", parts: [{ kind: "page", start: "495", line: 3 }] },
    },
    "a reporter of another identifier type": {
      pin: {
        raw: "495",
        parts: [{ kind: "page", start: "495" }],
        reporter: { type: "ecli", value: "ECLI:US:1954:483" },
      },
    },
  } as const;

  test("a malformed target or pin fails both readers instead of being dropped", () => {
    for (const [name, fields] of Object.entries(malformed)) {
      expect({ name, ...readers({ ...plain, ...fields }) }).toEqual({
        name,
        canonical: false,
        persisted: false,
      });
    }
  });

  test("a star page and a paragraph pin are valid", () => {
    expect(
      readers({
        ...plain,
        pin: {
          raw: "at *3, ¶ 12",
          parts: [
            { kind: "page", start: "*3" },
            { kind: "paragraph", start: "12" },
          ],
          reporter,
        },
      }),
    ).toEqual({ canonical: true, persisted: true });
  });
});
