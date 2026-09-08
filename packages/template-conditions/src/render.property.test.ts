import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  FILTER_NAMES,
  classifyMarker,
  scanMarkers,
  type FilterArgument,
  type FilterCall,
  type MarkerPrefix,
} from "./markers.js";
import {
  isWritableMarkerLiteral,
  isWritableMarkerText,
  renderForOpener,
  renderValueMarker,
} from "./render.js";

// Text a caller may put in a label, a hint or a prompt: quotes of both shapes,
// backslashes, commas, pipes and parentheses are what the chain's own syntax is
// made of, so they are exactly the strings the escaping has to survive.
const literalText = fc.stringMatching(/^[- ,.|()'"\\a-zA-Zá-ž0-9]{0,24}$/u);

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

const path = fc
  .array(fc.constantFrom("tenant", "name", "fee_2", "sub-total", "díl"), {
    minLength: 1,
    maxLength: 3,
  })
  .map((segments) => segments.join("."));

/** Only chains whose strings the grammar can hold are writable at all; the
 *  rest are refused at the boundary, which is what this filter stands for. */
const writable = (filters: readonly FilterCall[]): boolean =>
  filters.every(({ args }) =>
    args.every((arg) => isWritableMarkerLiteral(arg.value)),
  );

describe("rendering a marker the scanner reads back", () => {
  test("a value marker round-trips through the classifier", () => {
    fc.assert(
      fc.property(path, chain, (fieldPath, filters) => {
        fc.pre(writable(filters));
        const text = renderValueMarker(fieldPath, filters);
        expect(classifyMarker(text.slice(2, -2), "output")).toEqual({
          kind: "placeholder",
          expr: fieldPath,
          filters,
        });
      }),
      propertyConfig(),
    );
  });

  test("a value marker is one scannable span in surrounding text", () => {
    fc.assert(
      fc.property(path, chain, (fieldPath, filters) => {
        fc.pre(writable(filters));
        const text = `before ${renderValueMarker(fieldPath, filters)} after`;
        const scanned = scanMarkers(text);
        expect(scanned).toHaveLength(1);
        expect(scanned[0]?.meta).toEqual({
          kind: "placeholder",
          expr: fieldPath,
          filters,
        });
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
          fc.pre(writable(filters));
          const text = renderForOpener({
            alias,
            path: arrayPath,
            filters,
            prefix,
          });
          const scanned = scanMarkers(text);
          expect(scanned).toHaveLength(1);
          expect(scanned[0]?.prefix).toBe(prefix);
          expect(scanned[0]?.meta).toEqual({
            kind: "for",
            alias,
            path: arrayPath,
            filters,
          });
        },
      ),
      propertyConfig(),
    );
  });

  test("a brace has no spelling inside a marker", () => {
    expect(isWritableMarkerText("a { b")).toBe(false);
    expect(isWritableMarkerText("a } b")).toBe(false);
    expect(isWritableMarkerText('a "quoted" \\ b')).toBe(true);
  });
});
