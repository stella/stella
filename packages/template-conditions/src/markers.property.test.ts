import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  assertNever,
  classifyMarker,
  classifyMarkerDefect,
  DIRECTIVE_KINDS,
  FILTER_NAMES,
  LOOP_PROPERTIES,
  scanInvalidMarkers,
  scanMarkers,
  type DirectiveKind,
  type MarkerMeta,
} from "./markers.js";

// One generated marker: the authored text and the metadata it must classify
// to. Every directive kind is generated, so a kind added to the grammar
// without a writable surface fails the coverage assertion below.
type AuthoredMarker = { text: string; meta: MarkerMeta };

const PATH_SEGMENTS = ["tenant", "name", "fee_2", "sub-total", "díl"] as const;

const path = fc
  .array(fc.constantFrom(...PATH_SEGMENTS), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("."));

const identifier = fc.constantFrom("item", "row", "party", "d");

const quotedText = fc.constantFrom("Indemnity", "Kaution", "Klauzule 1");

const placeholderMarker: fc.Arbitrary<AuthoredMarker> = fc
  .tuple(
    path,
    fc.subarray([
      ...FILTER_NAMES.filter(
        (n) => n === "text" || n === "number" || n === "required",
      ),
    ]),
  )
  .map(([expr, filters]) => ({
    text: `{{${filters.length === 0 ? ` ${expr} ` : ` ${expr} ${filters.map((f) => `| ${f}`).join(" ")} `}}}`,
    meta: {
      kind: "placeholder",
      expr,
      filters: filters.map((name) => ({ name, args: [] })),
    } satisfies MarkerMeta,
  }));

const clauseMarker: fc.Arbitrary<AuthoredMarker> = fc
  .tuple(
    quotedText,
    fc.option(fc.constantFrom("v3", "latest"), { nil: undefined }),
  )
  .map(([name, version]) => ({
    text:
      version === undefined
        ? `{{ clause("${name}") }}`
        : `{{ clause("${name}", "${version}") }}`,
    meta: { kind: "clause", name, version } satisfies MarkerMeta,
  }));

const numMarker: fc.Arbitrary<AuthoredMarker> = path.map((key) => ({
  text: `{{ num("${key}") }}`,
  meta: { kind: "num", key } satisfies MarkerMeta,
}));

const refMarker: fc.Arbitrary<AuthoredMarker> = path.map((key) => ({
  text: `{{ ref("${key}") }}`,
  meta: { kind: "ref", key } satisfies MarkerMeta,
}));

const loopMarker: fc.Arbitrary<AuthoredMarker> = fc
  .constantFrom(...LOOP_PROPERTIES)
  .map((property) => ({
    text: `{{ loop.${property} }}`,
    meta: { kind: "loop", property } satisfies MarkerMeta,
  }));

const CONDITIONS = [
  "signed",
  'country == "PL"',
  "not signed",
  'rent > 1000 and "guarantor" in parties',
  "deposit is defined",
] as const;

const prefix = fc.constantFrom("", "p ", "tr ");

const ifMarker: fc.Arbitrary<AuthoredMarker> = fc
  .tuple(fc.constantFrom(...CONDITIONS), prefix)
  .map(([expr, tag]) => ({
    text: `{%${tag === "" ? " " : tag}if ${expr} %}`,
    meta: { kind: "if", expr } satisfies MarkerMeta,
  }));

const elifMarker: fc.Arbitrary<AuthoredMarker> = fc
  .tuple(fc.constantFrom(...CONDITIONS), prefix)
  .map(([expr, tag]) => ({
    text: `{%${tag === "" ? " " : tag}elif ${expr} %}`,
    meta: { kind: "elif", expr } satisfies MarkerMeta,
  }));

const elseMarker: fc.Arbitrary<AuthoredMarker> = prefix.map((tag) => ({
  text: `{%${tag === "" ? " " : tag}else %}`,
  meta: { kind: "else" } satisfies MarkerMeta,
}));

const endifMarker: fc.Arbitrary<AuthoredMarker> = prefix.map((tag) => ({
  text: `{%${tag === "" ? " " : tag}endif %}`,
  meta: { kind: "endif" } satisfies MarkerMeta,
}));

const forMarker: fc.Arbitrary<AuthoredMarker> = fc
  .tuple(identifier, path, prefix)
  .map(([alias, loopPath, tag]) => ({
    text: `{%${tag === "" ? " " : tag}for ${alias} in ${loopPath} %}`,
    meta: {
      kind: "for",
      alias,
      path: loopPath,
      filters: [],
    } satisfies MarkerMeta,
  }));

const endforMarker: fc.Arbitrary<AuthoredMarker> = prefix.map((tag) => ({
  text: `{%${tag === "" ? " " : tag}endfor %}`,
  meta: { kind: "endfor" } satisfies MarkerMeta,
}));

const markerOfKind = (kind: DirectiveKind): fc.Arbitrary<AuthoredMarker> => {
  switch (kind) {
    case "placeholder":
      return placeholderMarker;
    case "clause":
      return clauseMarker;
    case "num":
      return numMarker;
    case "ref":
      return refMarker;
    case "loop":
      return loopMarker;
    case "if":
      return ifMarker;
    case "elif":
      return elifMarker;
    case "else":
      return elseMarker;
    case "endif":
      return endifMarker;
    case "for":
      return forMarker;
    case "endfor":
      return endforMarker;
    default:
      return assertNever(kind);
  }
};

const authoredMarker = fc.oneof(
  ...DIRECTIVE_KINDS.map((kind) => markerOfKind(kind)),
);

describe("marker round-trip", () => {
  test("every authored directive scans back to its own metadata", () => {
    fc.assert(
      fc.property(authoredMarker, ({ meta, text }) => {
        const [scanned, ...rest] = scanMarkers(text);
        expect(rest).toEqual([]);
        expect(scanned?.meta).toEqual(meta);
        expect(text.slice(scanned?.start, scanned?.end)).toBe(
          scanned?.raw ?? "",
        );
      }),
      propertyConfig(),
    );
  });

  test("a document of authored markers scans them all, in order", () => {
    fc.assert(
      fc.property(
        fc.array(authoredMarker, { minLength: 1, maxLength: 8 }),
        (markers) => {
          const text = markers.map(({ text: t }) => t).join(" text ");
          expect(scanMarkers(text).map(({ meta }) => meta)).toEqual(
            markers.map(({ meta }) => meta),
          );
          expect(scanInvalidMarkers(text)).toEqual([]);
        },
      ),
      propertyConfig(),
    );
  });
});

describe("scanner robustness", () => {
  // Brace soup arrives from real documents: Word splits runs mid-marker, an
  // author deletes half a tag, a paste leaves a stray `%}`. No input may
  // throw, and the two scans must stay exact complements of each other.
  const braceSoup = fc
    .array(
      fc.constantFrom(
        "{",
        "}",
        "%",
        "|",
        '"',
        "'",
        "(",
        ")",
        ",",
        ".",
        " ",
        "a",
        "1",
        "#",
        "@",
        "/",
        "if",
        "for",
        "endfor",
        "loop",
        "clause",
        "“",
        " ",
      ),
      { maxLength: 60 },
    )
    .map((parts) => parts.join(""));

  test("no input throws, and every span lands in exactly one scan", () => {
    fc.assert(
      fc.property(braceSoup, (text) => {
        const recognized = scanMarkers(text);
        const invalid = scanInvalidMarkers(text);
        for (const marker of [...recognized, ...invalid]) {
          expect(text.slice(marker.start, marker.end)).toBe(marker.raw);
        }
        const offsets = new Set(
          [...recognized, ...invalid].map(({ start }) => start),
        );
        expect(offsets.size).toBe(recognized.length + invalid.length);
        for (const { form, inner } of invalid) {
          expect(classifyMarker(inner, form)).toBeNull();
          classifyMarkerDefect(inner, form);
        }
      }),
      propertyConfig(),
    );
  });
});
