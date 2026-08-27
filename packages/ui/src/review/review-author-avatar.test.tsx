import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  ReviewAuthorAvatar,
  UNKNOWN_AUTHOR_LABEL,
} from "./review-author-avatar";

describe("ReviewAuthorAvatar", () => {
  test("falls back to initials when there is no image", () => {
    const markup = renderToStaticMarkup(
      <ReviewAuthorAvatar name="Eva Schmidt" />,
    );

    expect(markup).toContain("ES");
  });

  test("a blank stored name still yields a renderable fallback", () => {
    // The name column admits "", which would otherwise render an empty avatar.
    const markup = renderToStaticMarkup(<ReviewAuthorAvatar name="   " />);

    expect(markup).toContain("?");
  });

  test("the unknown placeholder is a label, not an empty string", () => {
    // Hosts pass their own translated label; the default has to be renderable
    // on its own so an avatar is never left with no accessible name.
    expect(UNKNOWN_AUTHOR_LABEL.trim().length).toBeGreaterThan(0);
  });

  test("a deleted account reads as inactive", () => {
    const markup = renderToStaticMarkup(
      <ReviewAuthorAvatar deleted name="Eva Schmidt" />,
    );

    expect(markup).toContain("grayscale");
  });
});
