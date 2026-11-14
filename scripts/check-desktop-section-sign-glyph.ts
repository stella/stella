import {
  isPlaceholderStellaMark,
  isStellaBrandIdentifier,
  PLACEHOLDER_STELLA_MARK_MESSAGE,
} from "../.oxlint-plugins/no-placeholder-stella-mark.ts";
import { isLoneSectionSign } from "../.oxlint-plugins/no-section-sign-glyph.ts";

const STATIC_MARKUP_GLOB = "{apps,packages}/*/**/*.{html,astro}";
// Keep the tag name disjoint from attributes to prevent super-linear backtracking.
const ELEMENT_WITH_TEXT =
  /<([A-Za-z][\w.:-]*)(?=[\s>])((?:[^<>"']|"[^"]*"|'[^']*')*)>([^<>]*)<\/\1\s*>/gu;
const ATTRIBUTE =
  /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)')\s*\}|([^\s]+)))?/gu;
const ELEMENT_TEXT = />([^<>]*)</gu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;

// Comments render nothing, so commented-out markup is blanked before the
// scan; its newlines stay so reported line numbers still match the file.
const withoutComments = (source: string) =>
  source.replaceAll(HTML_COMMENT, (comment) =>
    comment.replaceAll(/[^\n]/gu, " "),
  );

export const findLoneSectionSignLines = (html: string) => {
  const lines: number[] = [];
  const source = withoutComments(html);

  for (const match of source.matchAll(ELEMENT_TEXT)) {
    const text = match[1];
    if (text !== undefined && isLoneSectionSign(text)) {
      lines.push(source.slice(0, match.index + 1).split("\n").length);
    }
  }

  return lines;
};

// This is deliberately a static-markup check: frontmatter and raw-text
// elements contain code or CSS rather than rendered brand text.
const blankNonMarkup = (source: string) =>
  withoutComments(source).replaceAll(
    /^---[\s\S]*?^---|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gimu,
    (content) => content.replaceAll(/[^\n]/gu, " "),
  );

export const findPlaceholderStellaMarkLines = (markup: string) => {
  const lines: number[] = [];
  const source = blankNonMarkup(markup);

  for (const match of source.matchAll(ELEMENT_WITH_TEXT)) {
    const [, tag = "", attributes = "", text = ""] = match;
    const staticText = text.replaceAll(
      /\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\}/gu,
      (
        _expression,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
        template: string | undefined,
      ) => doubleQuoted ?? singleQuoted ?? template ?? "",
    );
    if (!isPlaceholderStellaMark(staticText)) {
      continue;
    }
    const brandAttribute = Array.from(attributes.matchAll(ATTRIBUTE)).some(
      ([
        ,
        name = "",
        quoted = "",
        singleQuoted = "",
        expressionQuoted = "",
        expressionSingleQuoted = "",
        unquoted = "",
      ]) =>
        (name === "class" ||
          name === "className" ||
          name === "aria-label" ||
          name.startsWith("data-")) &&
        (isStellaBrandIdentifier(name.startsWith("data-") ? name : "") ||
          isStellaBrandIdentifier(
            quoted ||
              singleQuoted ||
              expressionQuoted ||
              expressionSingleQuoted ||
              unquoted,
          )),
    );
    if (isStellaBrandIdentifier(tag) || brandAttribute) {
      lines.push(source.slice(0, match.index).split("\n").length);
    }
  }

  return lines;
};

export const checkStaticBrandMarks = async (root = process.cwd()) => {
  const violations: string[] = [];
  const files = Array.from(
    new Bun.Glob(STATIC_MARKUP_GLOB).scanSync({
      cwd: root,
      onlyFiles: true,
      followSymlinks: false,
    }),
  )
    .filter(
      (file) =>
        !/(?:^|\/)(?:node_modules|dist|build|coverage|\.[^/]+)(?:\/|$)/u.test(
          file,
        ),
    )
    .toSorted();

  for (const file of files) {
    const source = await Bun.file(`${root}/${file}`).text();
    for (const line of findPlaceholderStellaMarkLines(source)) {
      violations.push(`${file}:${line}: ${PLACEHOLDER_STELLA_MARK_MESSAGE}`);
    }
    if (!file.startsWith("apps/desktop/src/") || !file.endsWith(".html")) {
      continue;
    }
    for (const line of findLoneSectionSignLines(source)) {
      violations.push(
        `${file}:${line}: A lone '§' in markup renders as a literal glyph. Inline the StellaMark SVG instead.`,
      );
    }
  }

  return violations;
};

if (import.meta.main) {
  const violations = await checkStaticBrandMarks();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
}
