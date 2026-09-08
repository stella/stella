import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import {
  assertNever,
  DIRECTIVE_KINDS,
  scanInvalidMarkers,
  scanMarkers,
  type DirectiveKind,
  type FilterCall,
  type MarkerMeta,
} from "@stll/template-conditions";

import {
  formatMarker,
  rewriteFieldMarkerPath,
} from "@/routes/_protected.knowledge/-components/template-markers";

const PATH_SEGMENTS = ["buyer", "name", "fee_2", "sub-total", "díl"] as const;

const path = fc
  .array(fc.constantFrom(...PATH_SEGMENTS), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("."));

const identifier = fc.constantFrom("item", "party", "row");

const quotedText = fc.constantFrom(
  "Indemnity",
  "Kaution",
  'He said "no"',
  "back\\slash",
);

const FILTER_CHAINS = [
  [],
  [{ name: "required", args: [] }],
  [{ name: "label", args: [{ kind: "positional", value: "Purchase price" }] }],
  [
    { name: "number", args: [] },
    { name: "min", args: [{ kind: "positional", value: 0 }] },
  ],
  [{ name: "date", args: [{ kind: "keyword", name: "style", value: "long" }] }],
] as const satisfies readonly (readonly FilterCall[])[];

const filters = fc.constantFrom(...FILTER_CHAINS);

const CONDITIONS = [
  "signed",
  'country == "PL"',
  "not signed",
  'rent > 1000 and "guarantor" in parties',
  "deposit is defined",
] as const;

const metaOfKind = (kind: DirectiveKind): fc.Arbitrary<MarkerMeta> => {
  switch (kind) {
    case "placeholder":
      return fc
        .tuple(path, filters)
        .map(([expr, chain]) => ({ kind, expr, filters: chain }));
    case "clause":
      return fc
        .tuple(
          quotedText,
          fc.option(fc.constantFrom("v3", "latest"), { nil: undefined }),
        )
        .map(([name, version]) => ({ kind, name, version }));
    case "num":
    case "ref":
      return path.map((key) => ({ kind, key }));
    case "loop":
      return fc
        .constantFrom("index", "index0", "first", "last", "length" as const)
        .map((property) => ({ kind, property }));
    case "if":
    case "elif":
      return fc.constantFrom(...CONDITIONS).map((expr) => ({ kind, expr }));
    case "else":
    case "endif":
    case "endfor":
      return fc.constant({ kind });
    case "for":
      return fc
        .tuple(identifier, path, filters)
        .map(([alias, loopPath, chain]) => ({
          kind,
          alias,
          path: loopPath,
          filters: chain,
        }));
    default:
      return assertNever(kind);
  }
};

const markerMeta = fc.oneof(...DIRECTIVE_KINDS.map((kind) => metaOfKind(kind)));

describe("the Studio's marker writer and the grammar's scanner", () => {
  test("every directive kind the writer emits scans back to its own metadata", () => {
    fc.assert(
      fc.property(markerMeta, (meta) => {
        const text = formatMarker(meta);
        const [scanned, ...rest] = scanMarkers(text);
        expect(rest).toEqual([]);
        expect(scanned?.meta).toEqual(meta);
        expect(scanned?.raw).toBe(text);
      }),
      propertyConfig(),
    );
  });

  test("a document the Studio writes holds no unreadable marker", () => {
    fc.assert(
      fc.property(
        fc.array(markerMeta, { minLength: 1, maxLength: 8 }),
        (metas) => {
          const text = metas.map(formatMarker).join(" prose ");
          expect(scanMarkers(text).map(({ meta }) => meta)).toEqual(metas);
          expect(scanInvalidMarkers(text)).toEqual([]);
        },
      ),
      propertyConfig(),
    );
  });

  test("renaming a value marker's path keeps its field configuration", () => {
    fc.assert(
      fc.property(fc.tuple(path, path, filters), ([from, to, chain]) => {
        const rewritten = rewriteFieldMarkerPath(
          formatMarker({ kind: "placeholder", expr: from, filters: chain }),
          to,
        );
        expect(rewritten).not.toBeNull();
        expect(scanMarkers(rewritten ?? "").at(0)?.meta).toEqual({
          kind: "placeholder",
          expr: to,
          filters: chain,
        });
      }),
      propertyConfig(),
    );
  });
});
