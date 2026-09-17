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
