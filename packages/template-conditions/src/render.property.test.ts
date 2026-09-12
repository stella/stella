import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  FILTER_NAMES,
  classifyMarker,
  scanMarkers,
  type FilterArgument,
  type FilterCall,
  type MarkerForm,
  type MarkerPrefix,
} from "./markers.js";
import {
  renderForOpener,
  renderValueMarker,
  unwritableMarkerLiteral,
} from "./render.js";

// Text a caller may put in a label, a hint or a prompt. Quotes of both shapes,
// backslashes, commas, pipes and parentheses are what the chain's own syntax is
// made of, and braces are what the marker's own delimiters are made of
// (`pattern("^[0-9]{5}$")` is a regex): these are exactly the strings a quoted
// argument has to survive.
const literalText = fc.stringMatching(/^[-{} ,.|()'"\\a-zA-Zá-ž0-9]{0,24}$/u);

const literal = fc.oneof(
  literalText,
  fc.integer({ min: -9999, max: 9999 }),
  fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
);

const argument: fc.Arbitrary<FilterArgument> = fc.oneof(
  literal.map((value) => ({ kind: "positional" as const, value })),
  fc
    .tuple(fc.constantFrom("adapt", "sees_document", "full", "short"), literal)
    .map(([name, value]) => ({ kind: "keyword" as const, name, value })),
);

const filterCall: fc.Arbitrary<FilterCall> = fc
  .tuple(fc.constantFrom(...FILTER_NAMES), fc.array(argument, { maxLength: 3 }))
  .map(([name, args]) => ({ name, args }));

const chain = fc.array(filterCall, { maxLength: 4 });

// Keep every general chain shape while making this number spelling an
// inescapable part of each marker-form round trip.
const withNegativeZero = (filters: readonly FilterCall[]) => [
  ...filters,
  {
    args: [{ kind: "keyword", name: "adapt", value: -0 }],
    name: "text",
  } as const satisfies FilterCall,
];

const path = fc
  .array(fc.constantFrom("tenant", "name", "fee_2", "sub-total", "díl"), {
    minLength: 1,
    maxLength: 3,
  })
  .map((segments) => segments.join("."));

/** Only chains the grammar can hold in this brace pair are writable at all;
 *  the rest are refused at the boundary, which is what this filter stands for. */
const writable = (
  filters: readonly FilterCall[],
  form: MarkerForm = "output",
): boolean =>
  filters.every(({ args }) =>
    args.every((arg) => unwritableMarkerLiteral(arg.value, form) === null),
  );

describe("rendering a marker the scanner reads back", () => {
  test("a value marker round-trips through the classifier", () => {
    fc.assert(
      fc.property(path, chain, (fieldPath, filters) => {
        fc.pre(writable(filters));
        for (const renderedFilters of [filters, withNegativeZero(filters)]) {
          const text = renderValueMarker(fieldPath, renderedFilters);
          expect(classifyMarker(text.slice(2, -2), "output")).toEqual({
            kind: "placeholder",
            expr: fieldPath,
            filters: renderedFilters,
          });
        }
      }),
      propertyConfig(),
    );
  });

  test("a value marker is one scannable span in surrounding text", () => {
    fc.assert(
      fc.property(path, chain, (fieldPath, filters) => {
        fc.pre(writable(filters));
        for (const renderedFilters of [filters, withNegativeZero(filters)]) {
          const text = `before ${renderValueMarker(fieldPath, renderedFilters)} after`;
          const scanned = scanMarkers(text);
          expect(scanned).toHaveLength(1);
          expect(scanned[0]?.meta).toEqual({
            kind: "placeholder",
            expr: fieldPath,
            filters: renderedFilters,
          });
        }
      }),
      propertyConfig(),
    );
  });

  test("a loop opener round-trips with its placement prefix", () => {
    const prefixes: MarkerPrefix[] = ["none", "paragraph", "row"];
    fc.assert(
      fc.property(
        fc.constantFrom("item", "row", "party"),
        path,
        chain,
        fc.constantFrom(...prefixes),
        (alias, arrayPath, filters, prefix) => {
          fc.pre(writable(filters, "statement"));
          for (const renderedFilters of [filters, withNegativeZero(filters)]) {
            const text = renderForOpener({
              alias,
              path: arrayPath,
              filters: renderedFilters,
              prefix,
            });
            const scanned = scanMarkers(text);
            expect(scanned).toHaveLength(1);
            expect(scanned[0]?.prefix).toBe(prefix);
            expect(scanned[0]?.meta).toEqual({
              kind: "for",
              alias,
              path: arrayPath,
              filters: renderedFilters,
            });
          }
        },
      ),
      propertyConfig(),
    );
  });

  test("a quoted argument carries the marker's own delimiters as content", () => {
    const marker = renderValueMarker("zip", [
      {
        name: "pattern",
        args: [{ kind: "positional", value: "^[0-9]{5}$" }],
      },
    ]);
    expect(scanMarkers(`Postcode ${marker}.`)).toHaveLength(1);
    expect(classifyMarker(marker.slice(2, -2), "output")).toEqual({
      kind: "placeholder",
      expr: "zip",
      filters: [
        {
          name: "pattern",
          args: [{ kind: "positional", value: "^[0-9]{5}$" }],
        },
      ],
    });
  });

  test("a number the writer cannot spell is named", () => {
    expect(unwritableMarkerLiteral(1e21)).toBe("number-spelling");
    expect(unwritableMarkerLiteral(1024)).toBeNull();
    expect(unwritableMarkerLiteral("^[0-9]{5}$")).toBeNull();
  });

  test("a tag has no quoted run, so a brace in one is named", () => {
    expect(unwritableMarkerLiteral("a { b", "statement")).toBe("tag-delimiter");
    expect(unwritableMarkerLiteral("Attorneys", "statement")).toBeNull();
  });
});
