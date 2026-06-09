import { describe, expect, it } from "bun:test";

import {
  splitFrontmatter,
  toEditorMarkdown,
  toStoredMarkdown,
} from "./skill-body-markdown";

describe("skill body markdown boundary", () => {
  it("strips frontmatter for the editor and re-prepends it verbatim on save", () => {
    const raw = "---\nname: x\ndescription: y\n---\n\n# Title\n\nBody.";
    const editor = toEditorMarkdown(raw);
    expect(editor.startsWith("---")).toBe(false);
    expect(editor).toContain("# Title");
    const stored = toStoredMarkdown(editor, raw);
    expect(stored.startsWith("---\nname: x\ndescription: y\n---")).toBe(true);
  });

  it("leaves a body without frontmatter untouched at the boundary", () => {
    const raw = "# Title\n\nBody.";
    expect(splitFrontmatter(raw).frontmatter).toBe("");
    expect(toStoredMarkdown(toEditorMarkdown(raw), raw)).toContain("# Title");
  });

  it("shows guide comments as 💡 callouts and restores them on save", () => {
    const raw = "<!-- guide: do the thing -->\n\n# Title";
    const editor = toEditorMarkdown(raw);
    expect(editor).toContain("> 💡 do the thing");
    const stored = toStoredMarkdown(editor, raw);
    expect(stored).toContain("<!-- guide: do the thing -->");
    expect(stored).not.toContain("💡");
  });

  it("collapses multi-line guide text to one callout line", () => {
    const raw = "<!-- guide: first line\nsecond line -->";
    expect(toEditorMarkdown(raw)).toBe("> 💡 first line second line");
  });

  it("strips a redundant whole-heading bold but keeps partial emphasis", () => {
    // The live editor materialises the Heading style's bold onto the runs, so
    // toMarkdown emits `# **Title**`; that inner bold is redundant noise.
    const editor = "# **What this skill does**\n\n# Foo **bar**";
    const stored = toStoredMarkdown(editor, "");
    expect(stored).toContain("# What this skill does");
    expect(stored).toContain("# Foo **bar**");
  });

  it("round-trips guide callouts without drift on a second cycle", () => {
    const raw = "<!-- guide: keep me -->\n\n# Heading\n\nText.";
    const once = toStoredMarkdown(toEditorMarkdown(raw), raw);
    const twice = toStoredMarkdown(toEditorMarkdown(once), once);
    expect(twice).toBe(once);
  });
});
