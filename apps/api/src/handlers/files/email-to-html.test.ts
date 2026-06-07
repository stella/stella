import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  emailToHtml,
  parsedEmailToText,
  parseEmail,
  type ParsedEmail,
  renderEmailHtml,
  resolveEmailMimeType,
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

describe("resolveEmailMimeType", () => {
  test("keeps explicit email MIME types", () => {
    expect(
      resolveEmailMimeType({
        fileName: "message.bin",
        mimeType: "message/rfc822",
      }),
    ).toBe("message/rfc822");
  });

  test("recovers email MIME types from generic upload filenames", () => {
    expect(
      resolveEmailMimeType({
        fileName: "thread.EML",
        mimeType: "application/octet-stream",
      }),
    ).toBe("message/rfc822");
    expect(
      resolveEmailMimeType({
        fileName: "thread.MSG",
        mimeType: "application/octet-stream",
      }),
    ).toBe("application/vnd.ms-outlook");
  });

  test("returns null for non-email files", () => {
    expect(
      resolveEmailMimeType({
        fileName: "notes.md",
        mimeType: "application/octet-stream",
      }),
    ).toBeNull();
  });
});

describe("renderEmailHtml", () => {
  const htmlEmail = (overrides: Partial<ParsedEmail> = {}): ParsedEmail => ({
    subject: "Contract draft",
    from: "Jane Lawyer <jane@example.com>",
    to: ["client@example.org"],
    cc: [],
    date: "Mon, 02 Jun 2026 10:00:00 +0000",
    body: {
      type: "html",
      html: '<p>Hello <b>world</b></p><script>alert(1)</script><a href="javascript:alert(2)" onclick="steal()">x</a><a href="https://calendar.example/event">calendar</a><img src="cid:logo"><img src="https://tracker.example/p.gif">',
    },
    inlineImages: [
      { cid: "logo", mimeType: "image/png", dataBase64: PNG_BASE64 },
    ],
    attachments: [],
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

  test("strips obfuscated active URLs and base tags", () => {
    const html = renderEmailHtml(
      htmlEmail({
        body: {
          type: "html",
          html: [
            '<base href="https://attacker.example/">',
            '<a href="java\tscript:alert(1)">link text</a>',
            '<img src="java\nscript:alert(2)">',
            '<button formaction="vbscript:msgbox(1)">x</button>',
            '<svg><a xlink:href="javascript:alert(3)">x</a></svg>',
          ].join(""),
        },
      }),
    );

    expect(html).toContain(">link text</a>");
    expect(html).not.toContain("<base");
    expect(html).not.toContain("attacker.example");
    // eslint-disable-next-line no-script-url -- asserting the scheme was stripped
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("vbscript:");
    expect(html).not.toContain("<svg");
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

  test("inlines cid: images with padded src values", () => {
    const html = renderEmailHtml(
      htmlEmail({
        body: {
          type: "html",
          html: '<html><body><img src=" cid:logo "></body></html>',
        },
      }),
    );

    expect(html).toContain(`data:image/png;base64,${PNG_BASE64}`);
    expect(html).not.toContain("cid:logo");
  });

  test("strips remote images before preview rendering", () => {
    const html = renderEmailHtml(htmlEmail());
    expect(html).not.toContain("https://tracker.example/p.gif");
  });

  test("strips external links but keeps their text", () => {
    const html = renderEmailHtml(htmlEmail());
    expect(html).toContain(">calendar</a>");
    expect(html).not.toContain("https://calendar.example/event");
  });

  test("renders header fields", () => {
    const html = renderEmailHtml(htmlEmail());
    expect(html).toContain("Jane Lawyer &lt;jane@example.com&gt;");
    expect(html).toContain("Contract draft");
    expect(html).toContain("client@example.org");
  });

  test("styles nested message headers and hides duplicate raw headers", () => {
    const html = renderEmailHtml(
      htmlEmail({
        body: {
          type: "html",
          html: [
            '<div class="postal-email-header">',
            '<div class="postal-email-header-row">',
            '<div class="postal-email-header-key">From</div>',
            '<div class="postal-email-header-value">Ryan Finnie</div>',
            "</div>",
            '<div class="postal-email-header-row">',
            '<div class="postal-email-header-key">Subject</div>',
            '<div class="postal-email-header-value postal-email-header-subject">plain jane message</div>',
            "</div>",
            "</div>",
            "<div>Subject: plain jane message<br>From: Ryan Finnie<br>To: bob@domain.dom<br><br>This is a nested message body.</div>",
          ].join(""),
        },
      }),
    );

    expect(html).toContain(".postal-email-header");
    expect(html).toContain("Ryan Finnie");
    expect(html).toContain("plain jane message");
    expect(html).toContain("This is a nested message body.");
    expect(html).not.toContain("Subject: plain jane message");
    expect(html).not.toContain("To: bob@domain.dom");
  });

  test("forces sanitized calendar-style HTML onto a light preview surface", () => {
    const html = renderEmailHtml(
      htmlEmail({
        body: {
          type: "html",
          html: [
            '<html><head><meta name="color-scheme" content="light dark">',
            '<meta name="supported-color-schemes" content="light dark"></head>',
            '<body bgcolor="#111111" text="#09090b">',
            '<p class="primary-text">Calendar invitation</p>',
            '<span class="secondary-text">Join with Google Meet</span>',
            "</body></html>",
          ].join(""),
        },
      }),
    );

    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain("background: #fff");
    expect(html).toContain(".primary-text");
    expect(html).not.toContain("light dark");
    expect(html).not.toContain("bgcolor=");
    expect(html).not.toContain('text="#09090b"');
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

  test("formats sanitized headers and body text for extraction", () => {
    const text = parsedEmailToText(
      htmlEmail({
        body: {
          type: "html",
          html: '<p>First line</p><script>alert(1)</script><a href="https://example.com">visible link text</a>',
        },
      }),
    );

    expect(text).toContain("From: Jane Lawyer <jane@example.com>");
    expect(text).toContain("To: client@example.org");
    expect(text).toContain("Subject: Contract draft");
    expect(text).toContain("First line");
    expect(text).toContain("visible link text");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("https://example.com");
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
    "--BND",
    "Content-Type: text/plain; charset=utf-8",
    'Content-Disposition: attachment; filename="notes.txt"',
    "",
    "Attachment text",
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
    expect(html).not.toContain("https://example.com/remote.png");
  });

  test("keeps ordinary attachment bytes for extraction", async () => {
    const parsed = await parseEmail(toArrayBuffer(eml), "message/rfc822");
    const attachment = parsed.attachments.find(
      (item) => item.fileName === "notes.txt",
    );

    expect(attachment?.mimeType).toBe("text/plain");
    expect(attachment).toBeDefined();
    if (!attachment) {
      return;
    }
    expect(new TextDecoder().decode(attachment.bytes).trim()).toBe(
      "Attachment text",
    );
  });
});
