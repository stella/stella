import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { CourtBadge } from "./court-badge";
import type { CourtBadgeWeight } from "./court-badge";

/**
 * Every weight, and the foreground token it writes its text in.
 *
 * A record rather than a list, because both halves of the coverage have to
 * hold. Total over the union, so a weight added to the badge cannot compile
 * until it appears here; and the cases below iterate these values, so whatever
 * appears is exercised. A separate list would only ever be checked for the
 * names on it, which is the one-weight gap this file exists to close: the
 * weights were looked at one at a time, and that is how the apex kept an
 * inverted ink block while the other three were brought to body-text contrast.
 *
 * The mapped type binds each entry's `weight` to its own key, so an entry
 * cannot name a weight other than the one it is filed under.
 */
const WEIGHT_CASES = {
  solid: { weight: "solid", textToken: "text-foreground" },
  tinted: { weight: "tinted", textToken: "text-foreground" },
  outline: { weight: "outline", textToken: "text-foreground-strong-muted" },
  dashed: { weight: "dashed", textToken: "text-foreground-strong-muted" },
} as const satisfies {
  [W in CourtBadgeWeight]: { weight: W; textToken: string };
};

/** Values, not keys: `Object.values` keeps the entry types without a cast. */
const EVERY_WEIGHT = Object.values(WEIGHT_CASES);

const classesOf = (weight: CourtBadgeWeight) => {
  const markup = renderToStaticMarkup(
    <CourtBadge abbreviation="ÚS" weight={weight} />,
  );
  const className = /class="([^"]*)"/u.exec(markup)?.[1];
  if (className === undefined) {
    throw new Error(`no class attribute for weight "${weight}" in ${markup}`);
  }
  return className.split(/\s+/u);
};

/**
 * The tokens are semantic, so asserting the token is what covers both themes:
 * `--foreground` and `--background` swap places between light and dark, and a
 * weight that names a foreground token is legible in each by construction.
 * Asserting a computed colour would only ever cover the theme under test.
 */
describe("CourtBadge legibility", () => {
  test("no weight inverts its text onto a fill", () => {
    // The ÚS defect: the apex wrote `text-background` on `bg-foreground`, the
    // one treatment whose contrast collapses if anything touches either token.
    for (const { weight } of EVERY_WEIGHT) {
      const classes = classesOf(weight);

      expect(classes).not.toContain("text-background");
      expect(classes).not.toContain("bg-foreground");
    }
  });

  test("every weight writes its text in the foreground token it decided on", () => {
    for (const { textToken, weight } of EVERY_WEIGHT) {
      expect(classesOf(weight)).toContain(textToken);
    }
  });

  test("every weight keeps an edge, because the tint alone has none", () => {
    for (const { weight } of EVERY_WEIGHT) {
      const classes = classesOf(weight);

      expect(classes).toContain("border");
      expect(classes.some((name) => name.startsWith("border-"))).toBe(true);
    }
  });

  test("the apex is separated from the tinted rank by its edge", () => {
    const solid = classesOf("solid");
    const tinted = classesOf("tinted");

    expect(solid).toContain("border-foreground");
    expect(tinted).not.toContain("border-foreground");
    // Both sit on the same tint: the rank is carried by the border, so the
    // apex never becomes a filled block among 4%-tinted chips.
    expect(solid).toContain("bg-muted");
    expect(tinted).toContain("bg-muted");
  });

  test("the type keeps the room these capitals' diacritics need", () => {
    // Ú, Ř and Š rise above cap height; #3448 raised the box for them and
    // nothing pinned it afterwards.
    const classes = classesOf("solid");

    expect(classes).toContain("text-xs");
    expect(classes).toContain("leading-4");
    expect(classes).toContain("py-0.5");
    expect(classes).toContain("font-mono");
  });

  test("the abbreviation is written as given, in an LTR isolate", () => {
    const markup = renderToStaticMarkup(
      <CourtBadge abbreviation="ÚS" weight="solid" />,
    );

    expect(markup).toContain("ÚS");
    expect(markup).toContain('dir="ltr"');
    expect(markup).toContain('data-slot="court-badge"');
  });
});
