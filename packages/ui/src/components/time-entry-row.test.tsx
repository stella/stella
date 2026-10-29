import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { TimeEntryRow } from "./time-entry-row";

describe("TimeEntryRow", () => {
  test("renders only the parts it is given, framed as a card by default", () => {
    const markup = renderToStaticMarkup(
      <TimeEntryRow title="Share sale" duration="2.2 h" />,
    );

    expect(markup).toContain('data-slot="time-entry-row"');
    expect(markup).toContain("rounded-lg border");
    expect(markup).toContain("Share sale");
    expect(markup).toContain("2.2 h");
    expect(markup).not.toContain("text-xs");
  });

  test("sits in a divided list without a frame and dims a row left out", () => {
    const markup = renderToStaticMarkup(
      <TimeEntryRow
        frame="plain"
        inactive
        title="Share sale"
        meta="2026/MA/014"
        description="Buyer's comments on the SPA"
        duration="2.2 h"
      />,
    );

    expect(markup).not.toContain("rounded-lg border");
    expect(markup).toContain("opacity-55");
    expect(markup).toContain("2026/MA/014");
    expect(markup).toContain("Buyer&#x27;s comments on the SPA");
  });
});
