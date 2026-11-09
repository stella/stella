/**
 * Properties of the Polish role grammar over letter-spaced renderings: a
 * court spaces a heading or a signing label out for emphasis, and the spaced
 * line is the same line.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  isPlReasonsHeading,
  isPlSignatureLine,
} from "./polish-document-roles.js";

/** Lines the grammar reads, as the recorded decisions print them. */
const REASONS_HEADINGS = ["Uzasadnienie", "UZASADNIENIE"];
const SIGNING_LABELS = ["Przewodniczący:", "Przewodnicząca:", "Członkowie:"];

/** A line with its letters spaced out, one space between letters. */
const spacedOut = (line: string): string =>
  line
    .split(" ")
    .map((word) => word.replaceAll(/(?<=.)(?=.)/gu, " "))
    .join("  ");

const casing = fc.constantFrom(
  (line: string) => line,
  (line: string) => line.toLocaleUpperCase("pl-PL"),
);
const spacing = fc.constantFrom(
  (line: string) => line,
  spacedOut,
  (line: string) => ` ${line}  `,
);

describe("the Polish role grammar", () => {
  test("reads a spaced reasons heading as the heading", () => {
    assertProperty(
      "reads a spaced reasons heading as the heading",
      fc.property(
        fc.constantFrom(...REASONS_HEADINGS),
        casing,
        spacing,
        (line, cased, spaced) => {
          expect(isPlReasonsHeading(spaced(cased(line)))).toBe(true);
        },
      ),
    );
  });

  test("reads a spaced signing label as a signature, and a named one as none", () => {
    assertProperty(
      "reads a spaced signing label as a signature, and a named one as none",
      fc.property(
        fc.constantFrom(...SIGNING_LABELS),
        spacing,
        fc.constantFrom("", "…………", " ......."),
        fc.constantFrom("Anna Osiecka", "Jan Kowalski-Nowak"),
        (label, spaced, blank, name) => {
          expect(isPlSignatureLine(`${spaced(label)}${blank}`)).toBe(true);
          expect(isPlSignatureLine(`${spaced(label)} ${name}`)).toBe(false);
        },
      ),
    );
  });
});
