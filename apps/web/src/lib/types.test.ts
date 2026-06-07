import { describe, expect, test } from "bun:test";

import {
  EML_MIME,
  MARKDOWN_MIME,
  MSG_MIME,
  isEmailFile,
  isMarkdownFile,
} from "@/lib/consts";
import { isFileDisplayable } from "@/lib/types";

describe("markdown file displayability", () => {
  test("detects markdown from MIME type and filename", () => {
    expect(
      isMarkdownFile({
        fileName: "notes.txt",
        mimeType: `${MARKDOWN_MIME}; charset=utf-8`,
      }),
    ).toBe(true);
    expect(
      isMarkdownFile({
        fileName: "notes.markdown",
        mimeType: "application/octet-stream",
      }),
    ).toBe(true);
  });

  test("allows non-encrypted markdown files to open without a PDF derivative", () => {
    expect(
      isFileDisplayable({
        fileName: "notes.md",
        mimeType: "application/octet-stream",
        pdfFileId: null,
        encrypted: false,
      }),
    ).toBe(true);
  });

  test("does not open encrypted markdown without a PDF derivative", () => {
    expect(
      isFileDisplayable({
        fileName: "notes.md",
        mimeType: MARKDOWN_MIME,
        pdfFileId: null,
        encrypted: true,
      }),
    ).toBe(false);
  });
});

describe("email file displayability", () => {
  test("detects email files from MIME type and filename", () => {
    expect(
      isEmailFile({
        fileName: "message.bin",
        mimeType: EML_MIME,
      }),
    ).toBe(true);
    expect(
      isEmailFile({
        fileName: "thread.MSG",
        mimeType: "application/octet-stream",
      }),
    ).toBe(true);
  });

  test("allows non-encrypted email files to open without a PDF derivative", () => {
    expect(
      isFileDisplayable({
        fileName: "thread.eml",
        mimeType: "application/octet-stream",
        pdfFileId: null,
        encrypted: false,
      }),
    ).toBe(true);
    expect(
      isFileDisplayable({
        fileName: "thread.msg",
        mimeType: MSG_MIME,
        pdfFileId: null,
        encrypted: false,
      }),
    ).toBe(true);
  });

  test("does not open encrypted email without a PDF derivative", () => {
    expect(
      isFileDisplayable({
        fileName: "thread.eml",
        mimeType: EML_MIME,
        pdfFileId: null,
        encrypted: true,
      }),
    ).toBe(false);
  });
});
