import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { ProvisionReading } from "@/api/handlers/legislation/provision-text";
import {
  normalizeProvisionWording,
  provisionWordingChange,
  sameProvisionWording,
} from "@/api/handlers/legislation/provision-wording-change";

const reading = (
  text: string,
  governing: ProvisionReading["governing"] = [],
): ProvisionReading => ({ text, governing, governingTruncated: false });

// Spaces a consolidation may typeset between the same two words.
const whitespace = fc
  .array(fc.constantFrom(" ", "\n", "\t", " ", " ", " "), {
    minLength: 1,
    maxLength: 4,
  })
  .map((parts) => parts.join(""));
const word = fc
  .array(fc.constantFrom("a", "ř", "§", "1", ".", ",", "Ž", "(", "b"), {
    minLength: 1,
    maxLength: 8,
  })
  .map((parts) => parts.join(""));
const words = fc.array(word, { minLength: 1, maxLength: 12 });

const typeset = (parts: readonly string[], gaps: readonly string[]) =>
  parts.map((part, index) => `${gaps[index] ?? " "}${part}`).join("") +
  (gaps.at(-1) ?? "");

describe("provision wording comparison", () => {
  test("the same words typeset with other spaces and line breaks read as one wording", () => {
    assertProperty(
      "the same words typeset with other spaces and line breaks read as one wording",
      fc.property(
        words,
        fc.array(whitespace, { minLength: 13, maxLength: 13 }),
        fc.array(whitespace, { minLength: 13, maxLength: 13 }),
        (parts, gaps, otherGaps) => {
          const one = typeset(parts, gaps);
          const other = typeset(parts, otherGaps);
          expect(sameProvisionWording(reading(one), reading(other))).toBeTrue();
        },
      ),
    );
  });

  test("a changed character always reads as another wording", () => {
    assertProperty(
      "a changed character always reads as another wording",
      fc.property(
        words,
        fc.nat(),
        fc.constantFrom("x", "9", ";", "é", "ů"),
        (parts, at, replacement) => {
          const text = parts.join(" ");
          const index = at % text.length;
          fc.pre(text[index] !== replacement && text[index] !== " ");
          const changed = `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`;
          expect(changed).not.toBe(text);
          expect(
            sameProvisionWording(reading(text), reading(changed)),
          ).toBeFalse();
        },
      ),
    );
  });

  test("a removed space between two words is a change, not spacing", () => {
    expect(
      sameProvisionWording(
        reading("within thirty days"),
        reading("within thirtydays"),
      ),
    ).toBeFalse();
  });

  test("composed and decomposed letters are the same wording", () => {
    const composed = "Soud rozhodne o \u017ealob\u011b.";
    // The same letters, each written as a base letter and a combining caron.
    const decomposed = "Soud rozhodne o z\u030calobe\u030c.";
    expect(decomposed).not.toBe(composed);
    expect(
      sameProvisionWording(reading(composed), reading(decomposed)),
    ).toBeTrue();
  });

  test("normalizing a wording twice changes nothing more", () => {
    assertProperty(
      "normalizing a wording twice changes nothing more",
      fc.property(fc.string(), (text) => {
        const once = normalizeProvisionWording(text);
        expect(normalizeProvisionWording(once)).toBe(once);
      }),
    );
  });

  test("a changed lead-in changes a subdivision whose own words stayed", () => {
    const letter = "a) the buyer's consent,";
    expect(
      sameProvisionWording(
        reading(letter, [
          { anchor: "par_1-odst_1", position: "lead-in", text: "It requires" },
        ]),
        reading(letter, [
          {
            anchor: "par_1-odst_1",
            position: "lead-in",
            text: "It no longer requires",
          },
        ]),
      ),
    ).toBeFalse();
  });
});

describe("how a wording relates to the consolidation before it", () => {
  const current = reading("§ 240\nThe court shall rule.");

  test("the oldest consolidation on record makes no claim of change", () => {
    expect(provisionWordingChange(current, undefined)).toBe("earliest");
  });

  test("a consolidation without the provision before it means it was added", () => {
    expect(provisionWordingChange(current, { type: "absent" })).toBe("added");
  });

  test("an unreadable consolidation before it is neither a change nor no change", () => {
    expect(provisionWordingChange(current, { type: "unavailable" })).toBe(
      "unknown",
    );
  });

  test("the same words before it mean the act was only consolidated again", () => {
    expect(
      provisionWordingChange(current, {
        type: "found",
        reading: reading("§ 240\n\nThe court  shall rule."),
      }),
    ).toBe("unchanged");
  });

  test("other words before it mean the provision changed", () => {
    expect(
      provisionWordingChange(current, {
        type: "found",
        reading: reading("§ 240\nThe court may rule."),
      }),
    ).toBe("changed");
  });
});
