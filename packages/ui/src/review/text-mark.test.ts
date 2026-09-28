import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { cn } from "../lib/utils";
import type { TextMarkTone, TextMarkVariant } from "./text-mark";
import {
  SEARCH_HIT_DESCENDANT_MARK_CLASS,
  SEARCH_HIT_MARK,
  TEXT_MARK_TONE_COLOR,
  textMarkClass,
  textMarkHighlightRule,
} from "./text-mark";

const TONES = Object.keys(TEXT_MARK_TONE_COLOR).filter(
  (tone): tone is TextMarkTone => tone in TEXT_MARK_TONE_COLOR,
);
const LINE_VARIANTS = [
  "underline",
  "dotted",
  "wavy",
  "strike",
] as const satisfies readonly TextMarkVariant[];

const washPercent = (classes: string, prefix: string): string =>
  new RegExp(`(?:^| )${prefix}bg-\\(--text-mark\\)/(\\d+)(?: |$)`, "u").exec(
    classes,
  )?.[1] ?? panic(`no ${prefix}wash in "${classes}"`);

describe("textMarkClass", () => {
  // Tailwind generates only classes it can read in the source, so each
  // tone's class spells its hue out a second time; this keeps the two one.
  test("every tone's class sets the hue its colour names", () => {
    for (const tone of TONES) {
      expect(textMarkClass({ variant: "fill", tone }).split(" ")).toContain(
        `[--text-mark:${TEXT_MARK_TONE_COLOR[tone]}]`,
      );
    }
  });

  test("the active mark keeps its hue: a stronger wash and a ring of it", () => {
    for (const tone of TONES) {
      for (const variant of ["fill", ...LINE_VARIANTS] as const) {
        const rest = textMarkClass({ variant, tone });
        const active = textMarkClass({ variant, tone, state: "active" });

        // Never an uncoloured ring: the ring is the mark's own hue.
        expect(
          active.split(" ").filter((token) => token.startsWith("ring-")),
        ).toEqual(["ring-1", "ring-(--text-mark)"]);
        const restWash = rest.includes("bg-(--text-mark)/")
          ? Number(washPercent(rest, ""))
          : 0;
        expect(Number(washPercent(active, ""))).toBeGreaterThan(restWash);
      }
    }
  });

  test("a line mark picked out by a filter gains a wash; a fill mark is one", () => {
    for (const variant of LINE_VARIANTS) {
      expect(textMarkClass({ variant, tone: "success" })).not.toContain(
        "bg-(--text-mark)/",
      );
      expect(
        textMarkClass({ variant, tone: "success", state: "matched" }),
      ).toContain("bg-(--text-mark)/");
    }
    expect(
      textMarkClass({ variant: "fill", tone: "warning", state: "matched" }),
    ).toBe(textMarkClass({ variant: "fill", tone: "warning" }));
  });
});

describe("TextMark", () => {
  // `TextMark` merges a caller's classes through tailwind-merge, which drops
  // whichever of two classes it reads as setting the same property. Every
  // mark has to survive that merge whole.
  test("merging keeps every class of every mark", () => {
    for (const tone of TONES) {
      for (const variant of ["fill", ...LINE_VARIANTS] as const) {
        for (const state of ["rest", "matched", "active"] as const) {
          const classes = textMarkClass({
            variant,
            tone,
            state,
            weight: "medium",
          });
          expect(cn(classes)).toBe(classes);
        }
      }
    }
  });
});

describe("the search-hit mark", () => {
  test("the descendant form says exactly what the element form says", () => {
    expect(new Set(SEARCH_HIT_DESCENDANT_MARK_CLASS.split(" "))).toEqual(
      new Set(
        textMarkClass(SEARCH_HIT_MARK)
          .split(" ")
          .map((token) => `[&_mark]:${token}`),
      ),
    );
  });

  // `::highlight()` cannot take classes, so the highlight rule restates the
  // fill's wash; this keeps both themes of both states in step.
  test("the highlight rule washes as much as the fill classes do", () => {
    for (const state of ["rest", "active"] as const) {
      const classes = textMarkClass({ ...SEARCH_HIT_MARK, state });
      const [light, dark] = textMarkHighlightRule({
        name: "find",
        tone: SEARCH_HIT_MARK.tone,
        state,
      }).split("\n");

      expect(light).toStartWith("::highlight(find)");
      expect(light).toContain(`var(--warning) ${washPercent(classes, "")}%`);
      expect(dark).toStartWith(".dark ::highlight(find)");
      expect(dark).toContain(
        `var(--warning) ${washPercent(classes, "dark:")}%`,
      );
    }
  });
});
