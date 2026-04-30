// Non-HTML delimiters injected by ts_headline / pdb.snippet().
// The headline is HTML-escaped server-side, then these markers
// are replaced with <mark> tags — safe because the markers
// consist only of alphanumerics and underscores.
export const HIGHLIGHT_START = "__HL_START__";
export const HIGHLIGHT_STOP = "__HL_STOP__";

// `MaxFragments=3` splits the headline into up to 3 separate
// excerpts joined by `...`, surfacing more occurrences without
// inflating snippet length per result. The delimiter is rendered
// as a fragment separator by the result card.
export const TS_HEADLINE_CONFIG =
  "MaxWords=20, MinWords=8, MaxFragments=3, FragmentDelimiter=..., " +
  `StartSel=${HIGHLIGHT_START}, ` +
  `StopSel=${HIGHLIGHT_STOP}`;

/** HTML-escape text, then replace highlight markers with `<mark>` tags. */
export const escapeAndHighlight = (text: string): string => {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
  return escaped
    .replaceAll(HIGHLIGHT_START, "<mark>")
    .replaceAll(HIGHLIGHT_STOP, "</mark>");
};
