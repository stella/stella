import { describe, expect, test } from "bun:test";

import {
  clauseBodyToPlainText,
  clauseBodyToRichPatch,
} from "./clause-to-patch";
import type { ClauseBody } from "./types";

describe("clauseBodyToRichPatch", () => {
  test("maps each paragraph to its runs", () => {
    const body: ClauseBody = [
      { text: "Alpha", runs: [{ text: "Alpha", bold: true }] },
      { text: "Beta", runs: [{ text: "Beta", italic: true }] },
    ];

    expect(
      clauseBodyToRichPatch(body, {
        values: { x: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [
        { runs: [{ text: "Alpha", bold: true }] },
        { runs: [{ text: "Beta", italic: true }] },
      ],
    });
  });

  test("directive resolution preserves explicit false run formatting", () => {
    const body: ClauseBody = [
      { text: "{% if enabled %}" },
      {
        text: "{{ name }}",
        runs: [{ text: "{{ name }}", bold: false, italic: false }],
      },
      { text: "{% endif %}" },
    ];
    expect(
      clauseBodyToRichPatch(body, {
        values: { enabled: true, name: "Plain" },
        slotKey: "Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [{ runs: [{ text: "Plain", bold: false, italic: false }] }],
    });
  });

  test("stored legacy clauses retain literal markers without evaluating their branches", () => {
    const body: ClauseBody = [
      { text: "{% if enabled %}" },
      { text: '{{ num("section") }}' },
    ];
    expect(
      clauseBodyToRichPatch(body, {
        values: {},
        slotKey: "Terms",
        source: "stored",
      }).unwrap(),
    ).toEqual({
      paragraphs: [
        { runs: [{ text: "{% if enabled %}" }] },
        { runs: [{ text: '{{ num("section") }}' }] },
      ],
    });
  });

  test("falls back to a single text run when a paragraph has no runs", () => {
    const body: ClauseBody = [{ text: "Plain" }];

    expect(
      clauseBodyToRichPatch(body, {
        values: { x: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [{ runs: [{ text: "Plain" }] }],
    });
  });

  test("resolves a selected branch without directive markers", () => {
    const body: ClauseBody = [
      { text: "{% if x %}", isDirective: true, directiveKind: "if" },
      { text: "Conditional" },
      { text: "{% endif %}", isDirective: true, directiveKind: "endif" },
    ];

    expect(
      clauseBodyToRichPatch(body, {
        values: { x: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [{ runs: [{ text: "Conditional" }] }],
    });
  });

  test("keeps an intentional blank paragraph as an empty run", () => {
    // A blank line maps to one empty-text run, so the rich-patch engine keeps
    // the paragraph (it has a w:r) rather than dropping it as a stray fragment.
    const body: ClauseBody = [{ text: "" }];

    expect(
      clauseBodyToRichPatch(body, {
        values: { x: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [{ runs: [{ text: "" }] }],
    });
  });

  test("prefixes bullet items with a bullet marker", () => {
    const body: ClauseBody = [
      { text: "First", listKind: "bullet", listLevel: 0 },
      { text: "Second", listKind: "bullet", listLevel: 0 },
    ];

    expect(
      clauseBodyToRichPatch(body, {
        values: { x: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [
        { runs: [{ text: "• First" }] },
        { runs: [{ text: "• Second" }] },
      ],
    });
  });

  test("numbers ordered items sequentially, preserving run formatting", () => {
    const body: ClauseBody = [
      {
        text: "First",
        runs: [{ text: "First", bold: true }],
        listKind: "ordered",
        listLevel: 0,
      },
      { text: "Second", listKind: "ordered", listLevel: 0 },
    ];

    expect(
      clauseBodyToRichPatch(body, {
        values: { x: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [
        { runs: [{ text: "1. First", bold: true }] },
        { runs: [{ text: "2. Second" }] },
      ],
    });
  });

  test("nested ordered items indent and switch marker style by depth", () => {
    const body: ClauseBody = [
      { text: "Top", listKind: "ordered", listLevel: 0 },
      { text: "Sub", listKind: "ordered", listLevel: 1 },
      { text: "SubSub", listKind: "ordered", listLevel: 2 },
      { text: "Top2", listKind: "ordered", listLevel: 0 },
    ];

    expect(
      clauseBodyToRichPatch(body, {
        values: { x: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [
        { runs: [{ text: "1. Top" }] },
        { runs: [{ text: "    a. Sub" }] },
        { runs: [{ text: "        i. SubSub" }] },
        { runs: [{ text: "2. Top2" }] },
      ],
    });
  });

  test("ordered numbering restarts after a non-list paragraph breaks the run", () => {
    const body: ClauseBody = [
      { text: "One", listKind: "ordered", listLevel: 0 },
      { text: "Break" },
      { text: "Fresh one", listKind: "ordered", listLevel: 0 },
    ];

    expect(
      clauseBodyToRichPatch(body, {
        values: { x: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [
        { runs: [{ text: "1. One" }] },
        { runs: [{ text: "Break" }] },
        { runs: [{ text: "1. Fresh one" }] },
      ],
    });
  });
});

describe("clauseBodyToPlainText", () => {
  test("keeps directive paragraphs so condition changes show up in diffs", () => {
    const body: ClauseBody = [
      { text: "{% if x %}", isDirective: true, directiveKind: "if" },
      { text: "Body" },
      { text: "{% endif %}", isDirective: true, directiveKind: "endif" },
    ];

    expect(clauseBodyToPlainText(body)).toBe("{% if x %}\nBody\n{% endif %}");
  });
});

test("loop placeholders spanning formatted runs resolve in the shared engine", () => {
  const body: ClauseBody = [
    { text: "{% for row in rows %}", isDirective: true },
    {
      text: "Name: {{ row.name }}",
      runs: [
        { text: "Name: ", italic: true },
        { text: "{{ row.", bold: true },
        { text: "name }}", bold: true },
      ],
    },
    { text: "{% endfor %}", isDirective: true },
  ];
  const patch = clauseBodyToRichPatch(body, {
    values: { rows: [{ name: "Alpha" }, { name: "Beta" }] },
    slotKey: "@clause:Terms",
  }).unwrap();
  if (typeof patch === "string") {
    throw new TypeError("expected a rich clause patch");
  }
  expect(patch).toEqual({
    paragraphs: [
      {
        runs: [
          { text: "Name: ", italic: true },
          { text: "Alpha", bold: true },
        ],
      },
      {
        runs: [
          { text: "Name: ", italic: true },
          { text: "Beta", bold: true },
        ],
      },
    ],
  });
});

test.each([false, true])(
  "substitutes a clause placeholder with block presence %j",
  (withBlock) => {
    const body: ClauseBody = [{ text: "Buyer: {{ buyer }}" }];
    if (withBlock) {
      body.unshift({ text: "{% if include %}", isDirective: true });
      body.push({ text: "{% endif %}", isDirective: true });
    }
    expect(
      clauseBodyToRichPatch(body, {
        values: { buyer: "ACME", include: true },
        slotKey: "@clause:Terms",
      }).unwrap(),
    ).toEqual({
      paragraphs: [{ runs: [{ text: "Buyer: " }, { text: "ACME" }] }],
    });
  },
);

test("placeholder-only clauses substitute markers split between opening braces", () => {
  const patch = clauseBodyToRichPatch(
    [
      {
        text: "{{ buyer }}",
        runs: [{ text: "{" }, { text: "{ buyer }}", bold: true }],
      },
    ],
    { values: { buyer: "ACME" }, slotKey: "@clause:Terms" },
  ).unwrap();
  expect(patch).toEqual({ paragraphs: [{ runs: [{ text: "ACME" }] }] });
});
