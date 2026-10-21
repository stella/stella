import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { CourtBadge } from "./court-badge";
import { LandingRowIcon } from "./landing";

describe("landing row icon", () => {
  test.each(["NS", "KS", "ÚS"])(
    "sizes to a two-letter court chip (%s) instead of clipping it",
    (abbreviation) => {
      const markup = renderToStaticMarkup(
        <LandingRowIcon>
          <CourtBadge abbreviation={abbreviation} weight="outline" />
        </LandingRowIcon>,
      );
      expect(markup).toContain(`>${abbreviation}</span>`);
      // A fixed square (`size-4`) is narrower than the chip; the slot may
      // only set a minimum width.
      expect(markup).toContain("min-w-4");
      expect(markup).not.toContain("size-4");
      expect(markup).not.toMatch(/\bw-4\b/u);
    },
  );
});
