// Boundary transforms between a stored skill markdown file and what the Folio
// WYSIWYG editor edits. Two concerns the editor must not show as raw text:
//
//  1. YAML frontmatter (SKILL.md only) — that's metadata, edited via the form
//     fields. It's split off before editing and re-prepended verbatim on save.
//  2. `<!-- guide: … -->` coaching notes — invisible HTML comments in a WYSIWYG
//     view. They become visible blockquote callouts (`> 💡 …`) the user reads
//     and deletes in place, and serialize back to comments on save so the
//     coaching counter keeps tracking what's left.
//
// The guide⇄callout transform is a reversible string mapping around the Folio
// bridge (fromMarkdown/toMarkdown), so the ported exporter stays untouched.

// Leads a guide callout's blockquote. Distinguishes coaching notes from the
// `> e.g. …` example blockquotes that blueprints also carry.
const GUIDE_CALLOUT_LEAD = "💡 ";
// The captured text is whitespace-normalised by the caller, so the pattern
// keeps no `\s*` around the lazy capture (that ambiguity is backtracking-prone).
const GUIDE_COMMENT_PATTERN = /<!--\s*guide:([\s\S]*?)-->/gu;
// One callout line: `> 💡 text`. Matched per line (toMarkdown renders a
// single-line blockquote for a single-line quote paragraph).
const GUIDE_CALLOUT_PATTERN = /^> 💡 (.*)$/gmu;

type SplitBody = {
  /** Frontmatter block including the closing `---` and trailing newline, or "". */
  frontmatter: string;
  /** Everything after the frontmatter (the editable content). */
  content: string;
};

export const splitFrontmatter = (raw: string): SplitBody => {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: "", content: raw };
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: "", content: raw };
  }
  // Include the closing fence line and the blank line after it, when present.
  let cut = end + "\n---".length;
  if (raw[cut] === "\n") {
    cut += 1;
  }
  if (raw[cut] === "\n") {
    cut += 1;
  }
  return { frontmatter: raw.slice(0, cut), content: raw.slice(cut) };
};

const guidesToCallouts = (md: string): string =>
  md.replace(GUIDE_COMMENT_PATTERN, (_match, text: string) => {
    const oneLine = text.replace(/\s+/gu, " ").trim();
    return `> ${GUIDE_CALLOUT_LEAD}${oneLine}`;
  });

const calloutsToGuides = (md: string): string =>
  md.replace(
    GUIDE_CALLOUT_PATTERN,
    (_match, text: string) => `<!-- guide: ${text.trim()} -->`,
  );

// The live editor materialises the Heading style's bold onto the heading runs,
// so toMarkdown faithfully emits `# **Title**`. An ATX heading is already
// emphasised, so the inner bold is redundant noise in the stored body. Strip it
// only when it wraps the whole heading (a partial emphasis like `# Foo **bar**`
// is intentional and left alone).
const HEADING_WHOLE_BOLD_PATTERN = /^(#{1,6}) \*\*(.+?)\*\*$/gmu;
const stripRedundantHeadingBold = (md: string): string =>
  md.replace(HEADING_WHOLE_BOLD_PATTERN, "$1 $2");

/** Stored markdown → what the editor opens: frontmatter stripped, guides shown. */
export const toEditorMarkdown = (raw: string): string =>
  guidesToCallouts(splitFrontmatter(raw).content);

/**
 * Editor markdown → stored markdown: callouts back to guide comments, original
 * frontmatter re-prepended. The frontmatter is preserved verbatim because the
 * authoritative metadata lives in DB columns (edited via the form fields), not
 * in the body.
 */
export const toStoredMarkdown = (
  editorMarkdown: string,
  raw: string,
): string => {
  const { frontmatter } = splitFrontmatter(raw);
  const body = stripRedundantHeadingBold(calloutsToGuides(editorMarkdown));
  return `${frontmatter}${body}`;
};
