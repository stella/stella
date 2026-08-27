import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ReviewSeverityDot } from "./review-severity-dot";
import { ReviewStatusBadge } from "./review-status-badge";

describe("ReviewStatusBadge", () => {
  test("outlines by default and fills outright only for `strong`", () => {
    const outline = renderToStaticMarkup(
      <ReviewStatusBadge tone="destructive">Deviation</ReviewStatusBadge>,
    );
    const solid = renderToStaticMarkup(
      <ReviewStatusBadge tone="destructive" variant="solid">
        Deviation
      </ReviewStatusBadge>,
    );
    const strong = renderToStaticMarkup(
      <ReviewStatusBadge tone="destructive" variant="strong">
        Critical
      </ReviewStatusBadge>,
    );

    expect(outline).toContain("border-destructive/30");
    expect(outline).not.toContain("bg-destructive");
    // A wash, not a fill.
    expect(solid).toContain("bg-destructive/12");
    expect(strong).toContain("bg-destructive text-destructive-foreground");
  });

  test("a dot inside a filled badge takes the badge's foreground", () => {
    // Without this the tone-coloured dot paints itself onto its own colour.
    const strong = renderToStaticMarkup(
      <ReviewStatusBadge
        icon={<ReviewSeverityDot level="critical" />}
        tone="destructive"
        variant="strong"
      >
        Critical
      </ReviewStatusBadge>,
    );
    const outline = renderToStaticMarkup(
      <ReviewStatusBadge
        icon={<ReviewSeverityDot level="critical" />}
        tone="destructive"
      >
        Critical
      </ReviewStatusBadge>,
    );

    // `&` arrives HTML-escaped in static markup, so match past it.
    expect(strong).toContain("[data-slot=review-status-dot]]:bg-current");
    expect(outline).not.toContain("bg-current");
  });

  test("every variant keeps one radius and padding convention", () => {
    for (const variant of ["outline", "solid", "strong"] as const) {
      const markup = renderToStaticMarkup(
        <ReviewStatusBadge tone="neutral" variant={variant}>
          Dismissed
        </ReviewStatusBadge>,
      );

      expect(markup).toContain("rounded-full");
      expect(markup).toContain("px-1.5 py-0.5");
    }
  });
});
