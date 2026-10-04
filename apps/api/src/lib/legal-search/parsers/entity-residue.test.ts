import { describe, expect, test } from "bun:test";

import {
  entityResidueIn,
  entityResiduesInStoredText,
} from "@/api/lib/legal-search/parsers/entity-residue";

describe("entity residue in stored decision text", () => {
  test("finds named references across the HTML5 name space", () => {
    const residue = entityResidueIn(
      "Rozhodnutie &CounterClockwiseContourIntegral; súdu",
    );

    expect(residue).toEqual({
      entity: "&CounterClockwiseContourIntegral;",
      index: "Rozhodnutie ".length,
    });
  });

  test("finds decimal and hexadecimal numeric references", () => {
    expect(entityResidueIn("&#253;")).toEqual({
      entity: "&#253;",
      index: 0,
    });
    expect(entityResidueIn("&#xFD;")).toEqual({ entity: "&#xFD;", index: 0 });
  });

  test("ignores unknown entity-shaped publisher text", () => {
    expect(
      entityResidueIn("spis &unknownPublisherCode; pokračuje"),
    ).toBeUndefined();
  });

  test("skips an unknown reference and finds a later known reference", () => {
    expect(entityResidueIn("&unknownPublisherCode; then &amp;")).toEqual({
      entity: "&amp;",
      index: "&unknownPublisherCode; then ".length,
    });
  });

  test("resets between calls and reads uppercase hex and numeric names", () => {
    expect(entityResidueIn("&#XFD;")).toEqual({ entity: "&#XFD;", index: 0 });
    expect(entityResidueIn("&#000253;")).toEqual({
      entity: "&#000253;",
      index: 0,
    });
    expect(entityResidueIn("&frac12;")).toEqual({
      entity: "&frac12;",
      index: 0,
    });
    expect(entityResidueIn("ordinary text")).toBeUndefined();
    expect(entityResidueIn("&amp;")).toEqual({ entity: "&amp;", index: 0 });
  });

  test("reports which selected stored text fields retain references", () => {
    expect(
      entityResiduesInStoredText([
        { field: "court", value: "Najvyšší súd" },
        { field: "metadata.judge", value: "JUDr. Novák &amp; synovia" },
        { field: "metadata.keyword", value: "&unknown;" },
      ]),
    ).toEqual([
      {
        field: "metadata.judge",
        entity: "&amp;",
        index: "JUDr. Novák ".length,
      },
    ]);
  });

  test("returns no finding when there is no character reference", () => {
    expect(
      entityResidueIn("Najvyšší súd Slovenskej republiky"),
    ).toBeUndefined();
  });
});
