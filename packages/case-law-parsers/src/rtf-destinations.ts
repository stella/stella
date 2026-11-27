// These wrappers carry drawing properties as well as nested visible text.
export const RTF_EMBEDDED_CONTAINERS: ReadonlySet<string> = new Set([
  "shp",
  "shpinst",
  "do",
  "object",
]);

// Keep their text as blocks following the paragraph that anchors the object.
export const RTF_VISIBLE_BLOCK_DESTINATIONS: ReadonlySet<string> = new Set([
  "shptxt",
  "dptxbxtext",
  "result",
]);
