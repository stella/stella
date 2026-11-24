import { describe, expect, test } from "bun:test";

import {
  parseChangelogInline,
  parseChangelogMarkdown,
  removeFirstMarkdownHeading,
} from "./changelog-markdown";

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

  test("keeps prose separate from headings, lists, images, and videos", () => {
    expect(
      parseChangelogMarkdown(
        [
          "# Release title",
          "A summary wrapped",
          "across two lines.",
          "- First change",
          "- Second change",
          "![The fork action on an answer](https://example.com/fork.png)",
          '<video controls src="https://example.com/demo.mp4"></video>',
        ].join("\n"),
      ),
    ).toEqual([
      { level: 1, text: "Release title", type: "heading" },
      { text: "A summary wrapped across two lines.", type: "paragraph" },
      { items: ["First change", "Second change"], type: "list" },
      {
        alt: "The fork action on an answer",
        src: "https://example.com/fork.png",
        type: "image",
      },
      { src: "https://example.com/demo.mp4", type: "video" },
    ]);
  });

  test("does not reinterpret a pasted screenshot as a video", () => {
    const screenshot =
      "![Chat fork](https://github.com/user-attachments/assets/82f63bcb-5f22-487e-a018-c60745244447)";

    expect(parseChangelogMarkdown(screenshot)).toEqual([
      {
        alt: "Chat fork",
        src: "https://github.com/user-attachments/assets/82f63bcb-5f22-487e-a018-c60745244447",
        type: "image",
      },
    ]);
  });
});

describe("changelog inline Markdown", () => {
  test("parses bold, inline code, and https links while downgrading unsafe links", () => {
    expect(
      parseChangelogInline(
        "Use **stella** with `@stll/ui` from [docs](https://stll.app) or [bad](http://example.com).",
      ),
    ).toEqual([
      { text: "Use ", type: "text" },
      { text: "stella", type: "bold" },
      { text: " with ", type: "text" },
      { text: "@stll/ui", type: "code" },
      { text: " from ", type: "text" },
      { href: "https://stll.app/", text: "docs", type: "link" },
      { text: " or ", type: "text" },
      { text: "bad", type: "text" },
      { text: ".", type: "text" },
    ]);
  });

  test("strips only the first level-1 heading", () => {
    expect(
      removeFirstMarkdownHeading(
        "# Maintenance release\n\nSummary.\n\n## Packages\n",
      ),
    ).toBe("Summary.\n\n## Packages");
  });
});
