/** Encode the only characters capable of opening or closing the XML-like
 * trust delimiter while preserving the summary's readable text for the model.
 */
export const escapeUntrustedSummary = (summary: string): string =>
  summary
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
