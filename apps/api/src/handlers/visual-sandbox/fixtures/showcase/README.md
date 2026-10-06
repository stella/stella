# Court and year showcase

`court-year-showcase.html` is an agent-authored page body and script.
`court-year-showcase.json` supplies the corresponding `show_visual` title,
data, and internal-link allowlist. All decisions and counts are synthetic;
replace the data and labels with tool-returned values for a real answer.
NS and NSS share the supreme court tier, so their boxes intentionally have
the same category color. Court identity is shown in text.

`court-year-showcase.en.json` provides English labels. Use them as `data.labels`
with `formattingLocale: "en-GB"` for the same page in English.

The canonical agent instructions are `../../guidance/showcase.ts`.
The `show_visual` description imports `VISUAL_SHOWCASE_GUIDANCE` when that tool
is integrated; this fixture does not register a tool or submit chat turns.

The focused page tests sanitize and execute the authored script, and use the
real treemap model for aggregate areas and zoom/drill selection. Browser tests
must separately exercise the real chart, frame bridge and composer chip.
