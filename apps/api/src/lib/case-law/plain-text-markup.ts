/**
 * What counts as markup in a plain-text field. One definition, shared by the
 * write-time sanitizer and the database guard, so both reject the same text.
 *
 * Structural and language-blind: a tag is `<`, an optional `/`, a name that
 * starts with a letter, optional attributes after whitespace, an optional `/`
 * and `>`. Comments, CDATA sections and processing instructions count too.
 * A `<` that does not open such a shape is text: `a < b`, `§ 5 < 3`, `x<y`,
 * `1 <= 2`, `<-` all stay. Known ambiguity: `a<b and c>d` has the shape of a
 * tag with boolean attributes and is treated as markup, as `<b>` must be.
 */

/**
 * Source shared verbatim with SQL (`col ~ source`). Attribute whitespace is
 * HTML's own set (space, tab, LF, FF, CR), spelled as character escapes both
 * engines read the same way; `\s` and `[[:space:]]` disagree on U+00A0 and
 * U+FEFF, which HTML does not treat as separators either.
 */
export const TAG_LIKE_MARKUP_SOURCE =
  "<!--|<!\\[CDATA\\[|<\\?[A-Za-z]|</?[A-Za-z][A-Za-z0-9:-]*([ \\t\\n\\f\\r][^<>]*)?/?>";

const TAG_LIKE_MARKUP = new RegExp(TAG_LIKE_MARKUP_SOURCE, "u");

export const containsTagLikeMarkup = (text: string): boolean =>
  TAG_LIKE_MARKUP.test(text);
