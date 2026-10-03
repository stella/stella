import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { IntlProvider } from "use-intl";

import {
  StatuteSearchResults,
  StatuteSearchSnippet,
} from "@/features/statutes/components/statute-search-results";
import type { StatuteSearchHit } from "@/features/statutes/queries/statutes";
import messages from "@/i18n/langs/en.json";

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
  test.each([
    ["&amp;", "&"],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&#x27;", "'"],
    ["&lt;&amp;&gt;&quot;&#x27;", "<&>\"'"],
    ["&amp;lt;", "&lt;"],
  ])(
    "complete entity %s renders as text inside and outside highlights",
    (encoded, decoded) => {
      for (const highlighted of [false, true]) {
        const headline = highlighted ? `<mark>${encoded}</mark>` : encoded;
        const markup = renderToStaticMarkup(
          <StatuteSearchSnippet headline={headline} />,
        );
        // A real HTML parser is the oracle; the decoder must consume exactly one
        // entity layer and keep publisher angle brackets inert.
        const container = new Window().document.createElement("div");
        // safe-html: markup is React's renderToStaticMarkup output for this test's own component, parsed in a detached happy-dom document.
        container.innerHTML = markup;
        expect(container.textContent).toBe(decoded);
        expect(markup.match(/<mark(?:\s|>)/gu)?.length ?? 0).toBe(
          highlighted ? 1 : 0,
        );
      }
    },
  );
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
