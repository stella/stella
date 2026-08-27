import { describe, expect, it } from "bun:test";

import {
  splitFrontmatter,
  toEditorMarkdown,
  toStoredMarkdown,
} from "@/components/skill-body-markdown";

describe("skill body markdown boundary", () => {
  it("strips frontmatter for the editor and re-prepends it verbatim on save", () => {
    const raw = "---\nname: x\ndescription: y\n---\n\n# Title\n\nBody.";
    const editor = toEditorMarkdown(raw);
    expect(editor).toBe("# Title\n\nBody.");
    expect(toStoredMarkdown(editor, raw)).toBe(raw);
  });

  it("leaves a body without frontmatter untouched at the boundary", () => {
    const raw = "# Title\n\nBody.";
    expect(splitFrontmatter(raw).frontmatter).toBe("");
    expect(toEditorMarkdown(raw)).toBe(raw);
    expect(toStoredMarkdown(raw, raw)).toBe(raw);
  });

  it("passes guide comments through untouched in both directions", () => {
    const raw = "<!-- guide: do the\nthing -->\n\n# Title";
    const editor = toEditorMarkdown(raw);
    expect(editor).toBe(raw);
    expect(toStoredMarkdown(editor, raw)).toBe(raw);
  });

  it("normalizes CRLF once and is then a fixed point", () => {
    const raw = "---\r\nname: x\r\n---\r\n\r\n# Title\r\n";
    const once = toStoredMarkdown(toEditorMarkdown(raw), raw);
    expect(once).toBe("---\nname: x\n---\n\n# Title\n");
    expect(toStoredMarkdown(toEditorMarkdown(once), once)).toBe(once);
  });

  it("keeps an unterminated frontmatter fence as content", () => {
    const raw = "---\nname: x\n# Title";
    expect(splitFrontmatter(raw)).toEqual({ frontmatter: "", content: raw });
  });
});
