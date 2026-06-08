/**
 * Markdown escaping. Only characters that would change the parsed structure
 * get escaped. Context-sensitive: pipes only matter inside table cells.
 *
 * Ported from eigenpal/docx-editor PR #595 (`@eigenpal/docx-editor-core/markdown`).
 */

/**
 * Escape only characters that would change markdown structure mid-text:
 *   - backslash, backtick, asterisk, brackets (always)
 *   - underscore: only at word boundaries (emphasis trigger)
 *   - angle brackets: only when they look like a tag/autolink
 *
 * Characters like `.` `-` `+` `#` `(` `)` `!` are only meaningful at line
 * starts or in specific adjacency; we let the block-level renderer decide
 * when to escape those.
 */
export function escapeInline(text: string): string {
  let out = text.replace(/([\\`*[\]])/gu, "\\$1");
  // Underscore as emphasis marker: only at word boundaries.
  out = out.replace(/(^|\s)_/gu, "$1\\_");
  out = out.replace(/_(\s|$)/gu, "\\_$1");
  // Angle brackets only escaped when they form a plausible HTML tag — an
  // alphabetic name immediately followed by attributes/end. Prose like `x < y`
  // and `i < n` stays untouched.
  out = out.replace(/<(\/?[A-Za-z][\w-]*)(?=[\s/>])/gu, "\\<$1");
  return out;
}

/**
 * Cells use `|` as the column separator. The input is already markdown (each
 * cell is a rendered paragraph that ran through {@link escapeInline}), so a
 * backslash escape would interact with existing escape sequences — encode the
 * pipe as the HTML entity instead, which GFM renders as a literal `|` without
 * treating it as a delimiter. Newlines become `<br>` to keep the row on one
 * line.
 */
export function escapeTableCell(text: string): string {
  return text.replace(/\|/gu, "&#124;").replace(/\r?\n/gu, "<br>");
}

/**
 * Hyperlink URLs in inline form need parens balanced; we URL-encode the
 * problematic characters rather than escape, so the link still resolves.
 */
export function escapeLinkUrl(url: string): string {
  return url.replace(/[()<>"\s]/gu, encodeURIComponent);
}

/**
 * Alt text inside `![alt](url)`. Raw (un-escaped) text, so escape the backslash
 * first, then the brackets that would confuse the link parser, and collapse
 * newlines so the alt stays single-line.
 */
export function escapeAltText(text: string): string {
  return text.replace(/([\\[\]])/gu, "\\$1").replace(/\r?\n/gu, " ");
}
