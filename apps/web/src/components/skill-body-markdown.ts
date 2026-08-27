// Boundary between a stored SKILL.md and what the markdown editor edits. The
// YAML frontmatter is metadata edited via the form fields, so it is split off
// before editing and re-prepended verbatim on save. Everything else, including
// `<!-- guide: … -->` coaching comments, is edited as-is: the hybrid editor
// shows HTML comments in place, so no lossy rewrite is needed.

type SplitBody = {
  /** Frontmatter block including the closing `---` and trailing newline, or "". */
  frontmatter: string;
  /** Everything after the frontmatter (the editable content). */
  content: string;
};

export const splitFrontmatter = (raw: string): SplitBody => {
  // Normalize CRLF so the fence detection works for files authored on Windows.
  // The editor emits LF, so the normalized form is also what gets stored back.
  const lf = raw.replaceAll("\r\n", "\n");
  if (!lf.startsWith("---\n")) {
    return { frontmatter: "", content: lf };
  }
  const end = lf.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: "", content: lf };
  }
  // Include the closing fence line and the blank line after it, when present.
  let cut = end + "\n---".length;
  if (lf[cut] === "\n") {
    cut += 1;
  }
  if (lf[cut] === "\n") {
    cut += 1;
  }
  return { frontmatter: lf.slice(0, cut), content: lf.slice(cut) };
};

/** Stored markdown → what the editor opens: frontmatter stripped. */
export const toEditorMarkdown = (raw: string): string =>
  splitFrontmatter(raw).content;

/**
 * Editor markdown → stored markdown: original frontmatter re-prepended. It is
 * preserved verbatim because the authoritative metadata lives in DB columns
 * (edited via the form fields), not in the body.
 */
export const toStoredMarkdown = (editorMarkdown: string, raw: string): string =>
  `${splitFrontmatter(raw).frontmatter}${editorMarkdown}`;
