import { isLoneSectionSign } from "../.oxlint-plugins/no-section-sign-glyph.ts";

const DESKTOP_HTML_GLOB = "apps/desktop/src/**/*.html";
const ELEMENT_TEXT = />([^<>]*)</gu;

export const findLoneSectionSignLines = (source: string) => {
  const lines: number[] = [];

  for (const match of source.matchAll(ELEMENT_TEXT)) {
    const text = match[1];
    if (text !== undefined && isLoneSectionSign(text)) {
      lines.push(source.slice(0, match.index + 1).split("\n").length);
    }
  }

  return lines;
};

export const checkDesktopHtml = async (root = process.cwd()) => {
  const violations: string[] = [];
  const files = Array.from(
    new Bun.Glob(DESKTOP_HTML_GLOB).scanSync({ cwd: root, onlyFiles: true }),
  ).toSorted();

  for (const file of files) {
    const source = await Bun.file(`${root}/${file}`).text();
    for (const line of findLoneSectionSignLines(source)) {
      violations.push(
        `${file}:${line}: A lone '§' in markup renders as a literal glyph. Inline the StellaMark SVG instead.`,
      );
    }
  }

  return violations;
};

if (import.meta.main) {
  const violations = await checkDesktopHtml();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
}
