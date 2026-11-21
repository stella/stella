# Court and year showcase

`court-year-showcase.html` is an agent-authored page body and script.
`court-year-showcase.json` supplies the corresponding `show_visual` title,
data, and internal-link allowlist. All decisions and counts are synthetic;
replace the data and labels with tool-returned values for a real answer.
NS and NSS share the supreme court tier, so their boxes intentionally have
the same category color. Court identity is shown in text.

`court-year-showcase.en.json` provides English labels. Use them as `data.labels`
with `formattingLocale: "en-GB"` for the same page in English.

The canonical agent instructions are `../../../chat/tools/visual-showcase-guidance.ts`.
The `show_visual` description imports `VISUAL_SHOWCASE_GUIDANCE` when that tool
is integrated; this fixture does not register a tool or submit chat turns.

The focused page tests sanitize and execute the authored script, and use the
real treemap model for aggregate areas and zoom/drill selection. Browser tests
must separately exercise the real chart, frame bridge and composer chip.

The page calls only `stella` APIs. The host owns the opaque shell's nonce
handshake, including source/origin checks and a fresh handshake on reload;
authored pages do not send raw bridge messages or manage frame nonces.

`court-year-showcase.prepared.json` is the page `prepareGeneratedVisual` returns
for this fixture. Browser captures read it from disk; `showcase.test.ts` fails
when it drifts from the sanitizer output.

# Change-of-control exposure

`change-of-control-exposure.html` and `change-of-control-exposure.json` are the
generated view the seeded marketing agent thread shows in its final turn
(`apps/api/scripts/seed-marketing-agent-thread.ts`). The page uses only HTML,
kit classes and theme tokens: position totals, a value split bar and a
counterparty matrix. Its counterparties are the seeded Project Atlas data
room's own aggregates: `seed-marketing-agent-thread.test.ts` fails when they
drift from the seed, and `change-of-control-exposure.test.ts` runs the
sanitized page.

# Legal analysis showcase

`legal-analysis-showcase.html` and `legal-analysis-showcase.json` demonstrate a
source-limited analysis with summary cards, a decision checklist, cited case
cards, a timeline and an evidence comparison table. All facts, authorities and
link targets are synthetic examples; replace them with supplied facts and
tool-returned authority identifiers for a real answer. Keep unresolved questions
explicit and distinguish a missing date from a known date.

The page uses semantic HTML, kit classes and allowlisted theme tokens with
inline styles. It needs no network, imports, external stylesheets or SVG.
All copy, including status words, date labels and empty states, comes from
`data`. Supply localized text, `formattingLocale` and `direction` together;
`bdi` isolates citations in either reading direction. The host opens authority
links through `stella.openDecision` and the explicit link allowlist.

`legal-analysis-showcase.test.ts` prepares the page through the real sanitizer
and executes its script locally to verify section content, missing dates,
empty states, localized labels, text-only data rendering, authority actions
and readiness. It makes no provider calls. Browser layout and live-model
selection require separate validation.
