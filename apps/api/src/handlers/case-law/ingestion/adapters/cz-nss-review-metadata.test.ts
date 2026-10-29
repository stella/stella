import { describe, expect, test } from "bun:test";

import { parseCzNssDetailMetadata } from "./cz-nss";
import { parseCzNssPublisherReviewMetadata } from "./cz-nss-review-metadata";
import { parseNalusDetail } from "./cz-us";

describe("Czech publisher review metadata", () => {
  test.each([
    ["zamítnuto", "upheld"] as const,
    ["odmítnuto", "upheld"] as const,
    ["zrušeno a vráceno", "overturned"] as const,
    ["zrušeno / zamítnuto", "partly"] as const,
    ["částečně zrušeno", "partly"] as const,
    ["dosud nerozhodnuto", "pending"] as const,
    ["nerozhodnuto", "pending"] as const,
    ["", "unknown"] as const,
  ])(
    "normalizes the publisher's disposition %s without dropping its wording",
    (printed, outcome) => {
      const html = `<table><tr><td class="det-textval" data-field-id="krajskysoud">Krajský soud v Ostravě</td><td class="det-textval" data-field-id="kasacnistiznostoznacenivecivcelku">25 A 20/2024-35</td><td class="det-textval" data-field-id="rozhodnutonapkasst">${printed}</td></tr></table>`;
      const result = parseCzNssPublisherReviewMetadata(html);
      expect(result.publisherReviews.at(0)?.outcome).toBe(outcome);
      expect(
        result.publisherReviewMetadata.at(0)?.fields["rozhodnutonapkasst"],
      ).toBe(printed);
    },
  );
  test("does not invent a reviewed identity from the NALUS challenged-act taxonomy", async () => {
    const html = await Bun.file(
      new URL(
        "__fixtures__/cz-us-iii-us-3031-24-record-card.html",
        import.meta.url,
      ),
    ).text();
    const detail = parseNalusDetail(html);
    expect(detail?.challengedAct).toEqual(["rozhodnutí soudu"]);
    expect(detail?.rulingType).toEqual(["zamítnuto"]);
    expect(
      Object.values(detail ?? {})
        .flat()
        .join(" "),
    ).not.toContain("5 Tdo 1125/2023");
  });
  test("keeps the court's structured reviewed identity and outcome from the real pair", async () => {
    const html = await Bun.file(
      new URL(
        "__fixtures__/cz-nss-7-as-32-2025-review-table.html",
        import.meta.url,
      ),
    ).text();
    const reviews = [
      {
        reviewedCaseNumber: "25 A 20/2024-35",
        reviewedCourt: "Krajský soud v Ostravě",
        reviewedDecisionDate: "2025-01-16",
        outcome: "upheld",
      } as const,
    ];
    expect(parseCzNssPublisherReviewMetadata(html).publisherReviews).toEqual(
      reviews,
    );
    expect(parseCzNssDetailMetadata(html).publisherReviews).toEqual(reviews);
  });

  test("never pairs cells belonging to different reviewed judgments", () => {
    const first =
      '<tr><td class="det-textval" data-field-id="krajskysoud">Krajský soud v Ostravě</td></tr>';
    const second =
      '<tr><td class="det-textval" data-field-id="kasacnistiznostoznacenivecivcelku">25 A 20/2024-35</td></tr>';
    const parsed = parseCzNssPublisherReviewMetadata(
      `<table>${first}${second}</table>`,
    );
    expect(parsed.publisherReviews).toEqual([]);
    expect(parsed.publisherReviewMetadata.map((row) => row.status)).toEqual([
      "incomplete",
      "incomplete",
    ]);
  });
});
