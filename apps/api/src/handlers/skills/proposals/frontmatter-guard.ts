/**
 * A SKILL.md carries its identity (name, description, version, license) in a
 * YAML frontmatter block. A model asked to revise the body has no business
 * touching it, but nothing in a text generation stops it from rewriting the
 * name or dropping the block entirely, which would rename or invalidate the
 * skill on accept. These helpers make that detectable at the boundary.
 */

const FRONTMATTER_DELIMITER = "---";

const normalizeLineEndings = (text: string): string =>
  text.replaceAll("\r\n", "\n");

/**
 * The frontmatter block of a document: everything up to and including the
 * closing `---` line. Undefined when the document does not open with a
 * delimiter line or never closes the block, both of which are documents with
 * no frontmatter to preserve.
 */
export const extractFrontmatterBlock = (
  markdown: string,
): string | undefined => {
  const lines = normalizeLineEndings(markdown).split("\n");
  if (lines.at(0) !== FRONTMATTER_DELIMITER) {
    return undefined;
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line === FRONTMATTER_DELIMITER,
  );
  if (closingIndex === -1) {
    return undefined;
  }

  return lines.slice(0, closingIndex + 1).join("\n");
};

type PreservesFrontmatterOptions = {
  original: string;
  revised: string;
};

/**
 * Whether a revision kept the original's frontmatter block verbatim. A source
 * document without one imposes nothing, so the revision is free either way.
 */
export const preservesFrontmatter = ({
  original,
  revised,
}: PreservesFrontmatterOptions): boolean => {
  const originalBlock = extractFrontmatterBlock(original);
  if (originalBlock === undefined) {
    return true;
  }

  return extractFrontmatterBlock(revised) === originalBlock;
};
