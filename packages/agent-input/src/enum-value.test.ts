import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { normalizeEnumValue } from "./enum-value";
import type { Normalized } from "./normalized";

const legacyDistanceWithin = (
  left: string,
  right: string,
  limit: number,
): number => {
  if (Math.abs(left.length - right.length) > limit) {
    return limit + 1;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let best = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution =
        (previous[column - 1] ?? 0) +
        (left[row - 1] === right[column - 1] ? 0 : 1);
      const distance = Math.min(
        substitution,
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
      );
      current.push(distance);
      best = Math.min(best, distance);
    }
    if (best > limit) {
      return limit + 1;
    }
    previous = current;
  }
  return previous[right.length] ?? limit + 1;
};

const legacyNormalizeEnumValue = (
  input: string,
  allowed: readonly string[],
): Normalized<string> => {
  const listed = `The allowed values are ${allowed.map((value) => `"${value}"`).join(", ")}.`;
  const exact = allowed.find((value) => value === input);
  if (exact !== undefined) {
    return { ok: true, value: exact };
  }

  const folded = input.trim().toLowerCase();
  const loose = allowed.find((value) => value.trim().toLowerCase() === folded);
  if (loose !== undefined) {
    return {
      ok: true,
      value: loose,
      note: `Read ${JSON.stringify(input)} as ${JSON.stringify(loose)}.`,
    };
  }

  const closest = allowed.find(
    (value) => legacyDistanceWithin(folded, value.trim().toLowerCase(), 1) <= 1,
  );
  return {
    ok: false,
    received: JSON.stringify(input),
    expected: "one of a closed set of values",
    hint:
      closest === undefined ? listed : `Did you mean "${closest}"? ${listed}`,
  };
};

describe("closed enum values", () => {
  test("takes exact values and reads case or accent-folded spellings", () => {
    expect(normalizeEnumValue("ready", ["ready", "pending"])).toEqual({
      ok: true,
      value: "ready",
    });
    expect(normalizeEnumValue(" READY ", ["ready", "pending"])).toEqual({
      ok: true,
      value: "ready",
      note: 'Read " READY " as "ready".',
    });
    expect(normalizeEnumValue("Šablóna", ["sablona", "dokument"])).toEqual({
      ok: true,
      value: "sablona",
      note: 'Read "Šablóna" as "sablona".',
    });
  });

  test("keeps Czech name folding and inflection suggestions", () => {
    expect(normalizeEnumValue("Nováka", ["Novák"])).toEqual({
      ok: false,
      received: '"Nováka"',
      expected: "one of a closed set of values",
      hint: 'Did you mean "Novák"? The allowed values are "Novák".',
    });
    expect(normalizeEnumValue("Novákem", ["Novák"])).toEqual({
      ok: false,
      received: '"Novákem"',
      expected: "one of a closed set of values",
      hint: 'The allowed values are "Novák".',
    });
  });

  test("names the first allowed value among equally close near misses", () => {
    expect(normalizeEnumValue("kra", ["krs", "krt"])).toEqual({
      ok: false,
      received: '"kra"',
      expected: "one of a closed set of values",
      hint: 'Did you mean "krs"? The allowed values are "krs", "krt".',
    });
  });

  test("omits a suggestion when no allowed value is within one edit", () => {
    expect(
      normalizeEnumValue("companies-house", ["krs", "ares", "orsr"]),
    ).toEqual({
      ok: false,
      received: '"companies-house"',
      expected: "one of a closed set of values",
      hint: 'The allowed values are "krs", "ares", "orsr".',
    });
    expect(normalizeEnumValue("anything", [])).toEqual({
      ok: false,
      received: '"anything"',
      expected: "one of a closed set of values",
      hint: "The allowed values are .",
    });
  });

  test("suggests an astral enum value at one Unicode scalar edit", () => {
    expect(normalizeEnumValue("x", ["😀"])).toEqual({
      ok: false,
      received: '"x"',
      expected: "one of a closed set of values",
      hint: 'Did you mean "😀"? The allowed values are "😀".',
    });
    expect(normalizeEnumValue("žx😀", ["ž😀"])).toEqual({
      ok: false,
      received: '"žx😀"',
      expected: "one of a closed set of values",
      hint: 'Did you mean "ž😀"? The allowed values are "ž😀".',
    });
  });

  test("ASCII enum normalization matches the previous edit-distance behavior", () => {
    const asciiCharacters = [
      ...Array.from(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      ),
      "-",
      "_",
      " ",
      "\t",
      "\n",
      ".",
    ];
    const asciiText = fc
      .array(fc.constantFrom(...asciiCharacters), { maxLength: 12 })
      .map((characters) => characters.join(""));

    assertProperty(
      "ASCII enum normalization matches the previous edit-distance behavior",
      fc.property(
        asciiText,
        fc.array(asciiText, { maxLength: 5 }),
        (input, allowed) => {
          expect(normalizeEnumValue(input, allowed)).toEqual(
            legacyNormalizeEnumValue(input, allowed),
          );
        },
      ),
    );
  });
});
