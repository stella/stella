/**
 * The composer parses its input; a caller that forgets that ships the syntax
 * to the reader. These hold the two constructors to their promises: prose
 * survives the parser unchanged, and markup is refused at the door rather than
 * rendered as words.
 */

import type { JSONContent } from "@tiptap/react";
import { describe, expect, test } from "bun:test";

import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";
import {
  composerMarkdown,
  composerStoredMarkdown,
  composerText,
} from "@/components/chat-editor-source";

/** What the composer would show: its text nodes, in order. */
const rendered = (document: JSONContent): string =>
  (document.content?.[0]?.content ?? [])
    .map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? "")))
    .join("");

const isBold = (document: JSONContent, text: string): boolean =>
  (document.content?.[0]?.content ?? []).some(
    (node) =>
      node.text === text &&
      (node.marks ?? []).some((mark) => mark.type === "bold"),
  );

describe("composerText", () => {
  test("prose with composer syntax in it reads back verbatim", () => {
    for (const value of [
      "5 * 3 = 15",
      "snake_case_name and *starred*",
      "a `code` fence",
      "a backslash \\ and a <tag> in quoted text",
      "Clause 4.2 (a)—(c): payment within 30 days",
    ]) {
      expect(rendered(createChatComposerDocument(composerText(value)))).toBe(
        value,
      );
    }
  });

  test("escaped prose cannot smuggle markup past the Markdown guard", () => {
    expect(() =>
      composerMarkdown(`**Quote** ${composerText("<p>not a paragraph</p>")}`),
    ).not.toThrow();
  });
});

describe("composerMarkdown", () => {
  test("the composer's own bold token still marks text", () => {
    const document = createChatComposerDocument(
      composerMarkdown(`**${composerText("Issue:")}** Governing law`),
    );
    expect(isBold(document, "Issue:")).toBe(true);
    expect(rendered(document)).toBe("Issue: Governing law");
  });

  test("HTML is programmer misuse, not content", () => {
    expect(() => composerMarkdown("<p>x</p>")).toThrow(
      "The chat composer renders Markdown, not HTML.",
    );
    expect(() => composerMarkdown("<br/>")).toThrow(
      "The chat composer renders Markdown, not HTML.",
    );
  });
});

describe("composerStoredMarkdown", () => {
  // A saved prompt is the author's words: a tag in it is something they typed,
  // not a defect in a builder, and losing their prompt to a panic would be the
  // worse answer.
  const storedPrompt = "Draft a reply for **<Seller>** about <3 open points";

  test("a tag in stored content reads as the text it is", () => {
    expect(
      rendered(
        createChatComposerDocument(composerStoredMarkdown(storedPrompt)),
      ),
    ).toBe("Draft a reply for <Seller> about <3 open points");
  });

  test("Markdown in the same string still renders", () => {
    expect(
      isBold(
        createChatComposerDocument(composerStoredMarkdown(storedPrompt)),
        "<Seller>",
      ),
    ).toBe(true);
  });

  test("content is never refused and never dropped", () => {
    expect(() => composerStoredMarkdown("<p>x</p>")).not.toThrow();
    expect(
      rendered(createChatComposerDocument(composerStoredMarkdown("<p>x</p>"))),
    ).toBe("<p>x</p>");
  });
});
