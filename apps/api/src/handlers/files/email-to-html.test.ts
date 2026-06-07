import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  emailToHtml,
  type ParsedEmail,
  renderEmailHtml,
} from "./email-to-html";

const toArrayBuffer = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
};

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

describe("renderEmailHtml", () => {
  const htmlEmail = (overrides: Partial<ParsedEmail> = {}): ParsedEmail => ({
    subject: "Contract draft",
    from: "Jane Lawyer <jane@example.com>",
    to: ["client@example.org"],
    cc: [],
    date: "Mon, 02 Jun 2026 10:00:00 +0000",
    body: {
      type: "html",
      html: '<p>Hello <b>world</b></p><script>alert(1)</script><a href="javascript:alert(2)" onclick="steal()">x</a><img src="cid:logo"><img src="https://tracker.example/p.gif">',
    },
    inlineImages: [
      { cid: "logo", mimeType: "image/png", dataBase64: PNG_BASE64 },
    ],
    ...overrides,
  });

  test("strips scripts, inline handlers, and javascript: URLs", () => {
    const html = renderEmailHtml(htmlEmail());
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("onclick");
    // eslint-disable-next-line no-script-url -- asserting the scheme was stripped
    expect(html).not.toContain("javascript:");
  });

  test("keeps benign body markup", () => {
    const html = renderEmailHtml(htmlEmail());
    expect(html).toContain("Hello <b>world</b>");
  });

  test("inlines cid: images and drops the cid reference", () => {
    const html = renderEmailHtml(htmlEmail());
    expect(html).toContain(`data:image/png;base64,${PNG_BASE64}`);
    expect(html).not.toContain("cid:logo");
  });

  test("leaves remote images intact", () => {
    const html = renderEmailHtml(htmlEmail());
    expect(html).toContain("https://tracker.example/p.gif");
  });

  test("renders header fields", () => {
    const html = renderEmailHtml(htmlEmail());
    expect(html).toContain("Jane Lawyer &lt;jane@example.com&gt;");
    expect(html).toContain("Contract draft");
    expect(html).toContain("client@example.org");
  });

  test("escapes header values and renders text bodies in a pre block", () => {
    const html = renderEmailHtml(
      htmlEmail({
        subject: "A <b>bold</b> subject",
        body: { type: "text", text: "line1\n<not a tag>" },
      }),
    );
    expect(html).toContain("A &lt;b&gt;bold&lt;/b&gt; subject");
    expect(html).toContain("<pre");
    expect(html).toContain("&lt;not a tag&gt;");
  });
});

describe("emailToHtml (.eml)", () => {
  const eml = [
    "From: Jane Lawyer <jane@example.com>",
    "To: client@example.org",
    "Subject: Re: Contract draft",
    "Date: Mon, 02 Jun 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="BND"',
    "",
    "--BND",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>Hello <b>world</b></p>",
    "<script>alert(1)</script>",
    '<img src="cid:logo123">',
    '<img src="https://example.com/remote.png">',
    "</body></html>",
    "--BND",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo123>",
    'Content-Disposition: inline; filename="logo.png"',
    "",
    PNG_BASE64,
    "--BND--",
    "",
  ].join("\r\n");

  test("parses headers, sanitizes, and inlines the related image", async () => {
    const result = await emailToHtml(toArrayBuffer(eml), "message/rfc822");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    const html = result.value;

    expect(html).toContain("Jane Lawyer &lt;jane@example.com&gt;");
    expect(html).toContain("Re: Contract draft");
    expect(html).toContain("Hello <b>world</b>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("cid:logo123");
    expect(html).toContain(`data:image/png;base64,${PNG_BASE64}`);
    expect(html).toContain("https://example.com/remote.png");
  });
});
