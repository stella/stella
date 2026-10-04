import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { mapInputRefLeaves } from "./input-ref-path";

/**
 * A path, an input holding leaves at it, and where those leaves sit, generated
 * together so the property covers the grammar rather than one tool's shape.
 * Every container on the way also holds a `decoy` the path does not address.
 */
type Shape = {
  path: string;
  input: Record<string, unknown>;
  locations: string[];
};

const LEAF = "leaf";

const shapeArbitrary: fc.Arbitrary<Shape> = fc
  .array(
    fc.record({
      key: fc.constantFrom("a", "b", "c"),
      // How many elements an array segment holds; null is a plain key.
      each: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((segments) => {
    const locations: string[] = [];
    const build = (depth: number, parent: string): unknown => {
      const segment = segments[depth];
      if (segment === undefined) {
        locations.push(parent);
        return LEAF;
      }
      const location = parent === "" ? segment.key : `${parent}.${segment.key}`;
      const value =
        segment.each === null
          ? build(depth + 1, location)
          : Array.from({ length: segment.each }, (_, index) =>
              build(depth + 1, `${location}[${index}]`),
            );
      return { decoy: LEAF, [segment.key]: value };
    };
    const input = build(0, "");
    if (typeof input !== "object" || input === null) {
      throw new TypeError("a path has at least one segment");
    }
    return {
      path: segments
        .map(({ key, each }) => (each === null ? key : `${key}[]`))
        .join("."),
      input: { ...input },
      locations,
    };
  });

describe("input ref path", () => {
  test("visits exactly the addressed leaves, each under its own location", () => {
    fc.assert(
      fc.property(shapeArbitrary, ({ path, input, locations }) => {
        const visited: string[] = [];
        mapInputRefLeaves({
          input,
          path,
          mapLeaf: (value, location) => {
            expect(value).toBe(LEAF);
            visited.push(location);
            return value;
          },
        });
        expect(visited).toEqual(locations);
        expect(new Set(visited).size).toBe(visited.length);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("mapping there and back is the identity, and nothing off the path changes", () => {
    fc.assert(
      fc.property(shapeArbitrary, ({ path, input }) => {
        const snapshot = structuredClone(input);
        const there = mapInputRefLeaves({
          input,
          path,
          mapLeaf: (value, location) =>
            typeof value === "string" ? `${location}=${value}` : value,
        });
        const back = mapInputRefLeaves({
          input: there,
          path,
          mapLeaf: (value, location) =>
            typeof value === "string"
              ? value.slice(`${location}=`.length)
              : value,
        });

        expect(back).toEqual(snapshot);
        // The input itself is never written to.
        expect(input).toEqual(snapshot);
        expect(JSON.stringify(there).split(`"decoy":"${LEAF}"`).length).toBe(
          JSON.stringify(snapshot).split(`"decoy":"${LEAF}"`).length,
        );
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("an absent key or a wrongly shaped container addresses nothing", () => {
    const visit = (input: Record<string, unknown>) => {
      const visited: string[] = [];
      const output = mapInputRefLeaves({
        input,
        path: "positions[].sources[]",
        mapLeaf: (value, location) => {
          visited.push(location);
          return value;
        },
      });
      expect(output).toEqual(input);
      return visited;
    };

    expect(visit({})).toEqual([]);
    expect(visit({ positions: "ent_1" })).toEqual([]);
    expect(visit({ positions: [{ issue: "Term" }, "ent_1", null] })).toEqual(
      [],
    );
    expect(visit({ positions: [{ sources: "ent_1" }] })).toEqual([]);
    expect(visit({ positions: [{}, { sources: ["ent_1", 7] }] })).toEqual([
      "positions[1].sources[0]",
      "positions[1].sources[1]",
    ]);
  });
});
