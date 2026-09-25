import { afterEach, describe, expect, test } from "bun:test";

import {
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
  OCTET_STREAM_MIME_TYPE,
} from "@/api/mime-types";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

import { extractFileText, resolveExtractionMimeType } from "./extract-content";

const toArrayBuffer = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
};

const readFixture = async (fileName: string): Promise<ArrayBuffer> =>
  await Bun.file(`${import.meta.dir}/__fixtures__/${fileName}`).arrayBuffer();

describe("resolveExtractionMimeType", () => {
  test("recovers email MIME types from generic stored files", () => {
    expect(
      resolveExtractionMimeType({
        fileName: "thread.eml",
        mimeType: "application/octet-stream",
      }),
    ).toBe("message/rfc822");
    expect(
      resolveExtractionMimeType({
        fileName: "mail.msg",
        mimeType: "application/octet-stream",
      }),
    ).toBe("application/vnd.ms-outlook");
  });

  test("recovers direct text MIME types from generic stored files", () => {
    expect(
      resolveExtractionMimeType({
        fileName: "notes.md",
        mimeType: "application/octet-stream",
      }),
    ).toBe("text/markdown");
    expect(
      resolveExtractionMimeType({
        fileName: "invite.ics",
        mimeType: "application/octet-stream",
      }),
    ).toBe("text/calendar");
  });
});

const extractFixtureText = async (bytes: ArrayBuffer, mimeType: string) =>
  await extractFileText(testScannedFile({ bytes, mimeType }));

describe("extractFileText", () => {
  let logs: RecordingLogger | null = null;

  afterEach(() => {
    logs?.restore();
    logs = null;
  });

  test("extracts direct text files", async () => {
    const text = await extractFixtureText(
      toArrayBuffer("hello\nworld"),
      "text/plain",
    );

    expect(text).toBe("hello\nworld");
  });

  test("extracts PDF text through anydoc, including Form XObject text", async () => {
    const text = await extractFixtureText(
      await readFixture("xobject-text.pdf"),
      "application/pdf",
    );

    expect(text).toContain("Text inside a Form XObject");
  });

  test("returns no text for an image-only PDF so OCR can be requested", async () => {
    const text = await extractFixtureText(
      await readFixture("image-only.pdf"),
      "application/pdf",
    );

    expect(text).toBeNull();
  });

  test("routes a mixed text-and-scan PDF to OCR while extraction is whole-document", async () => {
    // anydoc classifies this document as image-based and rejects it with the
    // "OCR is required" marker the worker keys on. When anydoc ships per-page
    // extraction, this fixture should instead surface its native text pages
    // and this expectation must flip.
    const text = await extractFixtureText(
      await readFixture("mixed-3pages.pdf"),
      "application/pdf",
    );

    expect(text).toBeNull();
  });

  test("extracts email headers, body, and supported attachment text", async () => {
    const email = [
      "From: Jane Lawyer <jane@example.com>",
      "To: client@example.org",
      "Subject: Contract draft",
      "Date: Mon, 02 Jun 2026 10:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BND"',
      "",
      "--BND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Email body text.",
      "--BND",
      "Content-Type: text/plain; charset=utf-8",
      'Content-Disposition: attachment; filename="notes.txt"',
      "",
      "Attachment text.",
      "--BND--",
      "",
    ].join("\r\n");

    const text = await extractFixtureText(
      toArrayBuffer(email),
      "message/rfc822",
    );

    expect(text).toContain("From: Jane Lawyer <jane@example.com>");
    expect(text).toContain("To: client@example.org");
    expect(text).toContain("Subject: Contract draft");
    expect(text).toContain("Email body text.");
    expect(text).toContain("Attachment: notes.txt (text/plain)");
    expect(text).toContain("Attachment text.");
  });

  test("keeps email body when a supported attachment is malformed", async () => {
    const email = [
      "From: Jane Lawyer <jane@example.com>",
      "To: client@example.org",
      "Subject: Contract draft",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BND"',
      "",
      "--BND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Email body survives.",
      "--BND",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="broken.pdf"',
      "",
      "not a pdf",
      "--BND--",
      "",
    ].join("\r\n");

    const text = await extractFixtureText(
      toArrayBuffer(email),
      "message/rfc822",
    );

    expect(text).toContain("Subject: Contract draft");
    expect(text).toContain("Email body survives.");
    expect(text).not.toContain("Attachment: broken.pdf");
  });

  test("records an attachment that fails to extract and one it cannot read", async () => {
    const email = [
      "From: Jane Lawyer <jane@example.com>",
      "To: client@example.org",
      "Subject: Contract draft",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BND"',
      "",
      "--BND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Email body survives.",
      "--BND",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="damaged.pdf"',
      "",
      "%PDF-1.4",
      "not a pdf body",
      "--BND",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="unknown.pdf"',
      "",
      "not a pdf",
      "--BND--",
      "",
    ].join("\r\n");

    logs = installRecordingLogger();
    const text = await extractFixtureText(
      toArrayBuffer(email),
      "message/rfc822",
    );

    expect(text).toContain("Email body survives.");
    // A damaged document is an unexpected parser failure; content that is
    // not a readable format is an expected skip. Both leave a record.
    expect(
      logs
        .at("WARN")
        .filter(
          ({ message }) => message === "search.extraction.attachment_failed",
        )
        .map(({ attributes }) => attributes?.["attachment.errorCode"]),
    ).toEqual(["malformed"]);
    expect(
      logs
        .at("INFO")
        .filter(
          ({ message }) => message === "search.extraction.attachment_skipped",
        )
        .map(({ attributes }) => attributes?.["attachment.errorCode"]),
    ).toEqual(["unsupported"]);
  });

  test("extracts spreadsheet cells from every sheet", async () => {
    const text = await extractFixtureText(
      await readFixture("schedule.xlsx"),
      XLSX_MIME_TYPE,
    );

    // Header row, both data rows, and the numeric cells: a
    // spreadsheet read off the fit-to-page PDF derivative loses
    // whichever columns did not fit the rendered page.
    expect(text).toContain("Counterparty");
    expect(text).toContain("Acme s.r.o.");
    expect(text).toContain("1250000");
    expect(text).toContain("Beta a.s.");
    expect(text).toContain("2026-12-31");
    // Sheets past the first are reached.
    expect(text).toContain("Termination notice period is three months.");
  });

  test("extracts titles and body text from every slide", async () => {
    const text = await extractFixtureText(
      await readFixture("deck.pptx"),
      PPTX_MIME_TYPE,
    );

    expect(text).toContain("Deal Overview");
    expect(text).toContain("Share purchase agreement");
    expect(text).toContain("Closing set for Q4 2026");
    expect(text).toContain("Key Risks");
    expect(text).toContain("Pending litigation in Brno");
  });

  test("extracts office documents stored under a generic MIME type", async () => {
    const mimeType = resolveExtractionMimeType({
      fileName: "schedule.xlsx",
      mimeType: OCTET_STREAM_MIME_TYPE,
    });
    expect(mimeType).toBe(XLSX_MIME_TYPE);

    const text = await extractFixtureText(
      await readFixture("schedule.xlsx"),
      mimeType,
    );
    expect(text).toContain("Acme s.r.o.");
  });

  /**
   * The worker parses attacker-supplied bytes. A parser that
   * crashes, hangs, or rejects the input must cost this one file's
   * text and nothing more, so the contract is a `null` return rather
   * than a throw that would propagate into the upload pipeline.
   */
  test("returns null for malformed office documents instead of throwing", async () => {
    const truncated = (await readFixture("schedule.xlsx")).slice(0, 512);

    expect(await extractFixtureText(truncated, XLSX_MIME_TYPE)).toBeNull();
    expect(
      await extractFixtureText(
        toArrayBuffer("not a spreadsheet"),
        XLSX_MIME_TYPE,
      ),
    ).toBeNull();
    expect(
      await extractFixtureText(new ArrayBuffer(0), PPTX_MIME_TYPE),
    ).toBeNull();
  });
});
