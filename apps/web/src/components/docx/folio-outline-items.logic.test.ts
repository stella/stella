import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { retainOutlinePageNumbers } from "./folio-outline-items.logic";

type Heading = { id: string; label: string; level: number; meta?: string };

const OUTLINE_MAX_HEADINGS = 24;

// Ids drawn from a small pool so previous and next outlines share headings,
// as consecutive collections of one document do.
const heading = fc.record(
  {
    id: fc.constantFrom("10", "42", "90", "120", "150", "160"),
    label: fc.constantFrom("Definitions", "Waiver", "Notices"),
    level: fc.constantFrom(0, 1, 2),
    meta: fc.constantFrom("1", "2", "22", "23", "79"),
  },
  { requiredKeys: ["id", "label", "level"] },
);
const outline = fc
  .array(heading, { maxLength: OUTLINE_MAX_HEADINGS })
  .map((headings) => [...new Map(headings.map((h) => [h.id, h])).values()]);

describe("retainOutlinePageNumbers", () => {
  it("shows the last known page while the editor re-resolves it", () => {
    const previous: Heading[] = [
      { id: "10", label: "1. Definitions", level: 0, meta: "1" },
      { id: "90", label: "2. Waiver", level: 0, meta: "22" },
    ];
    const recollected: Heading[] = [
      { id: "10", label: "1. Definitions", level: 0 },
      { id: "90", label: "2. Waiver", level: 0 },
    ];

    expect(retainOutlinePageNumbers(previous, recollected)).toEqual(previous);
  });

  it("takes a moved heading's new page as soon as it is reported", () => {
    const previous: Heading[] = [
      { id: "90", label: "2. Waiver", level: 0, meta: "22" },
    ];
    const relaidOut: Heading[] = [
      { id: "90", label: "2. Waiver", level: 0, meta: "23" },
    ];

    expect(retainOutlinePageNumbers(previous, relaidOut)).toBe(relaidOut);
  });

  it("a reported page wins, an unreported one keeps the last known page, the rest of the heading is the new one", () => {
    assertProperty(
      "a reported page wins, an unreported one keeps the last known page, the rest of the heading is the new one",
      fc.property(outline, outline, (previous, next) => {
        const known = new Map(previous.map((h) => [h.id, h.meta]));
        const retained = retainOutlinePageNumbers(previous, next);

        expect(retained).toEqual(
          next.map((h) => {
            const meta = h.meta ?? known.get(h.id);
            return meta === undefined ? h : { ...h, meta };
          }),
        );
        // Nothing to carry hands the caller's array back unchanged.
        if (retained.every((h, index) => h.meta === next[index]?.meta)) {
          expect(retained).toBe(next);
        }
        expect(retainOutlinePageNumbers(retained, next)).toEqual(retained);
      }),
    );
  });
});
