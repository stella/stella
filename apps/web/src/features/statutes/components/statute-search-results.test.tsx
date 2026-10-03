import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  StatuteSearchResults,
  StatuteSearchSnippet,
} from "@/features/statutes/components/statute-search-results";
import type { StatuteSearchHit } from "@/features/statutes/queries/statutes";
import messages from "@/i18n/langs/en.json";

import { projectLegislationSearchHit } from "../../../../../api/src/handlers/legislation/search-response";
import { LIMITS } from "../../../../../api/src/lib/limits";
import { escapeSearchHtml } from "../../../../../api/src/lib/search/highlight";

const hit = {
  match: { type: "strict" },
  documentId: "act-1",
  eli: "eli/cz/sb/2012/89",
  slug: null,
  title: "Občanský zákoník",
  country: "CZE",
  language: "cs",
  documentType: "zákon",
  status: "current",
  effectiveDate: null,
  sourceUrl: null,
  headline: "náhrada <mark>škody</mark>",
  score: 1,
} satisfies StatuteSearchHit;

const render = ({
  hits = [],
  isLoading = false,
  hasNextPage = false,
}: {
  hits?: readonly StatuteSearchHit[];
  isLoading?: boolean;
  hasNextPage?: boolean;
}) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <StatuteSearchResults
        hits={hits}
        isLoading={isLoading}
        hasNextPage={hasNextPage}
        isFetchingNextPage={false}
        onLoadMore={() => undefined}
        titleLink={(item) => <a href="/act">{item.title}</a>}
      />
    </IntlProvider>,
  );

describe("public statute section results", () => {
  test("the web decoder never receives a partial entity from bounded headlines", () => {
    for (const character of ["&", "<", ">", '"', "'"]) {
      const entity = escapeSearchHtml(character);
      for (const highlighted of [false, true]) {
        const tagBytes = highlighted ? "<mark></mark>".length : 0;
        for (let remaining = 1; remaining <= entity.length; remaining += 1) {
          const prefix = "a".repeat(
            LIMITS.legislationSearchTextBytes.headline - tagBytes - remaining,
          );
          const text = prefix + entity;
          const projected = projectLegislationSearchHit({
            ...hit,
            headline: highlighted ? `<mark>${text}</mark>` : text,
          });
          const expected =
            prefix + (remaining === entity.length ? character : "");
          // Compare through the real decoder and React renderer, so escaped
          // fragments such as &l cannot survive as visible publisher text.
          expect(
            renderToStaticMarkup(
              <StatuteSearchSnippet headline={projected.headline ?? ""} />,
            ),
          ).toBe(
            renderToStaticMarkup(
              <StatuteSearchSnippet
                headline={
                  highlighted
                    ? `<mark>${escapeSearchHtml(expected)}</mark>`
                    : escapeSearchHtml(expected)
                }
              />,
            ),
          );
        }
      }
    }
  });
  test("loading and exhausted empty results are distinct", () => {
    expect(render({ isLoading: true })).toContain("Loading");
    expect(render({ isLoading: true })).not.toContain("No results");
    expect(render({})).toContain("No results");
  });
  test.each(["strict", "relaxed"] as const)(
    "%s hits retain their act title and passage",
    (type) => {
      const markup = render({
        hits: [{ ...hit, match: { type } }],
        hasNextPage: true,
      });
      expect(markup).toContain("Občanský zákoník");
      expect(markup).toContain("náhrada");
      expect(markup).toContain("<mark");
      expect(markup).toContain("škody");
      expect(markup).toContain("Load more");
      expect(render({ hits: [hit] })).not.toContain("Load more");
    },
  );
  test("publisher HTML stays text even inside a highlighted passage", () => {
    const markup = renderToStaticMarkup(
      <StatuteSearchSnippet
        headline={
          "<img src=x onerror=alert(1)><mark>&lt;script&gt;bad&lt;/script&gt;</mark> &amp; &#x27;"
        }
      />,
    );
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;img");
    expect(markup).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(markup).toContain("<mark");
    expect(markup).not.toContain("&amp;lt;");
  });
});
