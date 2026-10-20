import { Result } from "better-result";

// parser-output-unchanged: [cz-ns] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [cz-nss] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [cz-us] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [cz-regional] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [sk-courts] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [sk-us] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-courts] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-sn] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-kio] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-tk] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-nsa] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-ncourt] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-courts] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-vfgh] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-vwgh] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-bvwg] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-lvwg] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-asylgh] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-ubas] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-uvs] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-verg] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-umse] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-bks] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [at-findok] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [eu-ecj] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [hu-bhgy] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-kis] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-uodo] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
// parser-output-unchanged: [pl-uokik] HTML stripping moved unchanged from adapter utilities; output is byte-identical.
/**
 * Remove every `<`…`>` span, taking each `<` to the next `>` exactly as
 * `/<[^>]*>/g` does, and leaving a trailing unterminated `<` in place.
 *
 * Written as a scan rather than a pattern because both regex spellings
 * are wrong in their own way on the multi-megabyte pages this runs over.
 * `[^>]*` re-walks the remainder of the input from every `<` when no `>`
 * follows, which is quadratic; narrowing it to `[^<>]*` is linear but
 * silently weakens the strip, leaving `<script` behind on input like
 * `<script <x>`. Indexed scanning is linear and keeps the original
 * meaning.
 */
const stripTags = (html: string): string => {
  let out = "";
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      return out + html.slice(cursor);
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      // No closing bracket: `/<[^>]*>/` would not match here either.
      return out + html.slice(cursor);
    }
    out += html.slice(cursor, open);
    cursor = close + 1;
  }

  return out;
};

/**
 * Every entity form we decode, in one alternation so the whole string is
 * rewritten in a single pass.
 *
 * Decoding in separate passes double-unescapes: with `&amp;` replaced
 * before `&lt;`, the text `&amp;lt;` becomes `&lt;` and the next pass
 * turns it into `<`, so a document that escaped a literal `&lt;` comes
 * back as a bracket. One pass never re-reads what it just wrote.
 */
const HTML_ENTITY_PATTERN =
  /&(?<named>nbsp|amp|lt|gt);|&#[xX](?<hex>[0-9a-fA-F]+);|&#(?<dec>\d+);/gu;

/**
 * Replacer for HTML_ENTITY_PATTERN. Takes the captures positionally —
 * `replace` passes them in order before the offset — so the groups
 * object never has to be narrowed back out of the variadic tail.
 */
const decodeEntity = (
  entity: string,
  named: string | undefined,
  hex: string | undefined,
  dec: string | undefined,
): string => {
  if (named === "nbsp") {
    return " ";
  }
  if (named === "amp") {
    return "&";
  }
  if (named === "lt") {
    return "<";
  }
  if (named === "gt") {
    return ">";
  }

  const codePoint =
    hex === undefined
      ? Number.parseInt(dec ?? "", 10)
      : Number.parseInt(hex, 16);
  const decoded = Result.try(() => String.fromCodePoint(codePoint));
  // Invalid code points (out of range or lone surrogates) stay encoded.
  return Result.isError(decoded) ? entity : decoded.value;
};

/**
 * Strip HTML tags, decode common entities (including numeric
 * &#xNN; and &#NNNN; forms), and collapse excessive newlines.
 */
export const stripHtml = (html: string): string =>
  stripTags(html.replace(/<br\s*\/?>/giu, "\n"))
    .replace(HTML_ENTITY_PATTERN, decodeEntity)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
