import { describe, expect, test } from "bun:test";

import { createChatAttachmentPart } from "@/api/handlers/chat/chat-message-parts";
import type { CitationSection } from "@/api/handlers/chat/export/citation-footnotes";
import {
  assembleMessageMarkdown,
  buildChatExportDownload,
  composeExportMarkdown,
} from "@/api/handlers/chat/export/export-shared";
import type { ChatPart } from "@/api/handlers/chat/types";

const textPart = (content: string): ChatPart => ({ type: "text", content });

describe("assembleMessageMarkdown", () => {
  test("joins text parts verbatim with blank lines, preserving markdown", () => {
    const markdown = assembleMessageMarkdown([
      textPart("# Heading\n\n- item one\n- item two"),
      textPart("Second block."),
    ]);
    expect(markdown).toBe(
      "# Heading\n\n- item one\n- item two\n\nSecond block.",
    );
  });

  test("drops empty and whitespace-only text parts", () => {
    expect(assembleMessageMarkdown([textPart("   "), textPart("Body")])).toBe(
      "Body",
    );
  });

  test("ignores non-text parts", () => {
    const attachmentPart = createChatAttachmentPart({
      filename: "brief.pdf",
      mimeType: "application/pdf",
      url: "https://store.example/brief.pdf",
    });
    expect(assembleMessageMarkdown([attachmentPart, textPart("Body")])).toBe(
      "Body",
    );
  });
});

describe("composeExportMarkdown", () => {
  const section = (markdown: string): CitationSection => ({
    markdown,
    verifiedCount: 0,
    unverifiedCount: 0,
  });

  test("appends the citation section after a blank line", () => {
    expect(composeExportMarkdown("Body", section("## Sources\n\n1. A"))).toBe(
      "Body\n\n## Sources\n\n1. A",
    );
  });

  test("an empty section leaves the body untouched", () => {
    expect(composeExportMarkdown("Body", section(""))).toBe("Body");
  });
});

describe("buildChatExportDownload — presigned download shape", () => {
  test("returns the URL, file name, and an absolute ISO expiry", () => {
    const download = buildChatExportDownload({
      downloadUrl: "https://store.example/exports/abc.docx?sig=1",
      fileName: "Thread.docx",
      expiresInSeconds: 300,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    expect(download).toEqual({
      downloadUrl: "https://store.example/exports/abc.docx?sig=1",
      fileName: "Thread.docx",
      expiresAt: "2026-07-28T12:05:00.000Z",
    });
  });
});
