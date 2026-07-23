import { describe, expect, test } from "bun:test";

import { parseChangelogMarkdown } from "./changelog-markdown";

describe("changelog Markdown paragraphs", () => {
  test("treats consecutive source lines as one prose paragraph", () => {
    expect(
      parseChangelogMarkdown(
        [
          "This builds on our vision that everything in stella is controllable by humans",
          "and machines alike, as we blend the two in legal work.",
          "",
          "Document review now includes exact-passage citation highlights.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        text: "This builds on our vision that everything in stella is controllable by humans and machines alike, as we blend the two in legal work.",
        type: "paragraph",
      },
      {
        text: "Document review now includes exact-passage citation highlights.",
        type: "paragraph",
      },
    ]);
  });

  test("keeps prose separate from headings, lists, and videos", () => {
    expect(
      parseChangelogMarkdown(
        [
          "# Release title",
          "A summary wrapped",
          "across two lines.",
          "- First change",
          "- Second change",
          '<video controls src="https://example.com/demo.mp4"></video>',
        ].join("\n"),
      ),
    ).toEqual([
      { level: 1, text: "Release title", type: "heading" },
      { text: "A summary wrapped across two lines.", type: "paragraph" },
      { items: ["First change", "Second change"], type: "list" },
      { src: "https://example.com/demo.mp4", type: "video" },
    ]);
  });
});
