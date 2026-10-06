# Court and year showcase

`court-year-showcase.html` is an agent-authored page body and script.
`court-year-showcase.json` supplies the corresponding `show_visual` title,
data, and internal-link allowlist. All decisions and counts are synthetic;
replace the data and labels with tool-returned values for a real answer.
NS and NSS share the supreme court tier, so their boxes intentionally have
the same category color. Court identity is shown in text.

## Authoring guidance

1. Search the first page with `search_case_law`. Use `facets.courtYear` for
   the court/year overview, never counts computed from the returned hits.
   Preserve the court filter values, presentation names, tier, and nullable
   aggregate fields. If the aggregate is unavailable, search the first page
   again or explain its absence; never manufacture a distribution.
2. Pass only the buckets, visible ranking fields, localized labels, formatting
   locale, and decision links the page uses. Keep page-one/first-phrasing scope
   explicit. A truncated aggregate describes the displayed groups; its summed
   cardinality estimates must not be labelled as an exact search total.
3. Build court groups with year buckets and call `stella.charts.treemap`
   with `value: 'count'` and
   `color: { mode: 'category', field: 'tier', legend: true }`.
   Citations and treatment are unavailable aggregate measures today. Preserve
   nulls and do not offer a treatment toggle or citation color scale.
4. Rank the returned decisions by per-hit `citationCount`; deduplicate passage
   hits by decision before passing them to the page. Include only decisions with
   a known count. Label the list “most cited among top results”, never “most cited
   in the corpus”. Use `read_case_law_citations` when the question calls for
   citation detail, without treating a bounded citation page as a corpus total.
5. Resolve internal links through the `links` allowlist and
   `stella.openDecision(linkId)`. For a bucket selection, call
   `stella.drill({ court: node.court, year: node.year })`. The user sends the
   offered chip; selecting a bucket must not submit a chat turn automatically.
6. Localize every label in the user's language (Czech or English for this
   example), supply their full formatting locale, and call `stella.ready()`
   after mounting the chart and list. Keep scripts inline; use the supplied
   runtime without imports, network calls, or external assets.

The same HTML is reusable for a follow-up: pass the new search aggregate and
returned decisions with updated title/scope labels. Do not keep the previous
search's data after drilling.
