import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  buildEmailPreview,
  emailToHtml,
  emailToPreview,
  parsedEmailToText,
  parseEmail,
  type ParsedEmail,
  renderEmailBodyHtml,
  renderEmailHtml,
  resolveEmailMimeType,
  isEmailAttachmentPreviewable,
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
const SVG_BASE64 = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
).toString("base64");

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

describe("email attachment preview policy", () => {
  test("allows passive image and PDF types but not active or unknown content", () => {
    expect(isEmailAttachmentPreviewable("application/pdf")).toBe(true);
    expect(isEmailAttachmentPreviewable("image/png")).toBe(true);
    expect(isEmailAttachmentPreviewable("image/bmp")).toBe(false);
    expect(isEmailAttachmentPreviewable("image/tiff")).toBe(false);
    expect(isEmailAttachmentPreviewable("image/svg+xml")).toBe(false);
    expect(isEmailAttachmentPreviewable("text/html")).toBe(false);
    expect(isEmailAttachmentPreviewable(null)).toBe(false);
  });
});

describe("renderEmailHtml", () => {
  const htmlEmail = (overrides: Partial<ParsedEmail> = {}): ParsedEmail => ({
    subject: "Contract draft",
    from: "Jane Lawyer <jane@example.com>",
    to: ["client@example.org"],
    cc: [],
    bcc: [],
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

  test("preserves explicit body direction and defaults direction when absent", () => {
    const bodyDirection = renderEmailBodyHtml(
      htmlEmail({
        body: {
          type: "html",
          html: '<html><body dir="rtl"><p>Hello مرحبا</p></body></html>',
        },
      }),
    );
    const documentDirection = renderEmailBodyHtml(
      htmlEmail({
        body: {
          type: "html",
          html: '<html dir="ltr"><body><p>Hello مرحبا</p></body></html>',
        },
      }),
    );
    const inferredDirection = renderEmailBodyHtml(
      htmlEmail({
        body: {
          type: "html",
          html: "<html><body><p>Hello مرحبا</p></body></html>",
        },
      }),
    );

    expect(bodyDirection).toContain('<body dir="rtl">');
    expect(documentDirection).toContain('<html dir="ltr">');
    expect(documentDirection).not.toContain('<body dir="auto">');
    expect(inferredDirection).toContain('<body dir="auto">');
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

  test("does not inline cid images with unsafe MIME types", () => {
    const html = renderEmailHtml(
      htmlEmail({
        body: {
          type: "html",
          html: '<html><body><img src="cid:logo"></body></html>',
        },
        inlineImages: [
          { cid: "logo", mimeType: "image/svg+xml", dataBase64: SVG_BASE64 },
        ],
      }),
    );

    expect(html).not.toContain("data:image/svg+xml");
    expect(html).not.toContain("cid:logo");
    expect(html).not.toContain("src=");
  });

  test("strips srcset candidates before preview rendering", () => {
    const html = renderEmailHtml(
      htmlEmail({
        body: {
          type: "html",
          html: '<html><body><img src="cid:logo" srcset="cid:logo 1x, https://tracker.example/p.gif 2x"></body></html>',
        },
      }),
    );

    expect(html).toContain(`data:image/png;base64,${PNG_BASE64}`);
    expect(html).not.toContain("srcset=");
    expect(html).not.toContain("https://tracker.example/p.gif");
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

  test("keeps nested message headers while stripping duplicate raw headers and fetch vectors", () => {
    const preview = buildEmailPreview(
      htmlEmail({
        subject: "Návrh smlouvy ⚖️",
        from: "Žofie Nováková <zofie@example.cz>",
        to: ["李雷 <li@example.cn>"],
        cc: ["Renée <renee@example.fr>"],
        bcc: ["عائشة <aisha@example.ae>"],
        body: {
          type: "html",
          html: [
            '<div class="postal-email-header">',
            '<div class="postal-email-header-value">Forwarded message</div>',
            "</div>",
            "<div>",
            "From: Žofie Nováková &lt;zofie@example.cz&gt;<br>",
            "To: 李雷 &lt;li@example.cn&gt;<br>",
            "Subject: Návrh smlouvy ⚖️<br><br>",
            '<p style="background: url(https://attacker.example/style)">Message content</p>',
            '<img src="https://attacker.example/pixel.gif" onerror="steal()">',
            '<a href="https://attacker.example/link" ping="https://attacker.example/ping">safe text</a>',
            '<form action="https://attacker.example/submit"><input value="x"></form>',
            "<script>steal()</script><style>@import url(https://attacker.example/css)</style>",
            "</div>",
          ].join(""),
        },
        attachments: [
          {
            contentId: "attachment-id",
            fileName: "evidence.pdf",
            mimeType: "application/pdf",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );

    expect(preview).toMatchObject({
      subject: "Návrh smlouvy ⚖️",
      from: "Žofie Nováková <zofie@example.cz>",
      to: ["李雷 <li@example.cn>"],
      cc: ["Renée <renee@example.fr>"],
      bcc: ["عائشة <aisha@example.ae>"],
      attachments: [
        {
          id: "attachment-0",
          fileName: "evidence.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
          previewable: true,
        },
      ],
    });
    expect(Object.keys(preview.attachments.at(0) ?? {})).toEqual([
      "id",
      "fileName",
      "mimeType",
      "sizeBytes",
      "previewable",
    ]);
    expect(preview.bodyHtml).toStartWith("<!DOCTYPE html>");
    expect(preview.bodyHtml).toContain(
      "Content-Security-Policy\" content=\"default-src 'none'; img-src data:",
    );
    expect(preview.bodyHtml).toContain('<body dir="auto">');
    expect(preview.bodyHtml).toContain("Forwarded message");
    expect(preview.bodyHtml).toContain("Message content");
    expect(preview.bodyHtml).not.toContain("Návrh smlouvy ⚖️");
    expect(preview.bodyHtml).not.toContain("zofie@example.cz");
    expect(preview.bodyHtml).not.toContain("li@example.cn");
    expect(preview.bodyHtml).not.toContain("attacker.example");
    expect(preview.bodyHtml).not.toContain("<script");
    expect(preview.bodyHtml).not.toContain("@import");
    expect(preview.bodyHtml).not.toContain('style="');
    expect(preview.bodyHtml).not.toContain("<form");
    expect(preview.bodyHtml).not.toContain("onerror");
  });

  test("keeps a CID attachment when sanitization removes its only reference", () => {
    const preview = buildEmailPreview(
      htmlEmail({
        body: {
          type: "html",
          html: '<form><img src="cid:evidence"></form><p>Visible body</p>',
        },
        inlineImages: [
          {
            cid: "evidence",
            mimeType: "image/png",
            dataBase64: PNG_BASE64,
          },
        ],
        attachments: [
          {
            contentId: "evidence",
            fileName: "evidence.png",
            mimeType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );

    expect(preview.attachments).toEqual([
      {
        id: "attachment-0",
        fileName: "evidence.png",
        mimeType: "image/png",
        sizeBytes: 3,
        previewable: true,
      },
    ]);
    expect(preview.bodyHtml).toContain("Visible body");
    expect(preview.bodyHtml).not.toContain("cid:evidence");
    expect(preview.bodyHtml).not.toContain("<form");
  });

  test("caps descriptors after removing referenced inline parts", () => {
    const inlineAttachments = Array.from({ length: 100 }, (_, index) => ({
      contentId: `inline-${String(index)}`,
      fileName: `inline-${String(index)}.png`,
      mimeType: "image/png",
      bytes: new Uint8Array([index]),
    }));
    const preview = buildEmailPreview(
      htmlEmail({
        body: {
          type: "html",
          html: inlineAttachments
            .map(
              ({ contentId }) =>
                `<img src="cid:${contentId}" alt="inline image">`,
            )
            .join(""),
        },
        inlineImages: inlineAttachments.map(({ contentId }) => ({
          cid: contentId,
          mimeType: "image/png",
          dataBase64: PNG_BASE64,
        })),
        attachments: [
          ...inlineAttachments,
          {
            contentId: null,
            fileName: "evidence.pdf",
            mimeType: "application/pdf",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );

    expect(preview.attachments).toEqual([
      {
        id: "attachment-100",
        fileName: "evidence.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        previewable: true,
      },
    ]);
  });

  test("folds trailing HTML history and signatures without removing content", () => {
    const preview = buildEmailPreview(
      htmlEmail({
        body: {
          type: "html",
          html: [
            "<p>Current reply</p>",
            '<div class="gmail_signature" data-stella-email-fold="forged">Kind regards<br>Žofie</div>',
            '<div class="gmail_quote"><blockquote type="cite">Earlier message<script>steal()</script></blockquote></div>',
          ].join(""),
        },
      }),
    );

    expect(preview.bodyFolds).toEqual([
      { id: "fold-0", kind: "signature" },
      { id: "fold-1", kind: "quoted-history" },
    ]);
    expect(preview.bodyHtml).toContain(
      '<details data-stella-email-fold="signature"><summary data-stella-email-fold-summary="fold-0"></summary>',
    );
    expect(preview.bodyHtml).toContain(
      '<details data-stella-email-fold="quoted-history"><summary data-stella-email-fold-summary="fold-1"></summary>',
    );
    expect(preview.bodyHtml).toContain("Kind regards<br>Žofie");
    expect(preview.bodyHtml).toContain("Earlier message");
    expect(preview.bodyHtml).not.toContain("forged");
    expect(preview.bodyHtml).not.toContain("<script");
    expect(preview.bodyHtml).not.toContain("steal()");
  });

  test("keeps inline replies and quote-only messages expanded", () => {
    const inlineReply = buildEmailPreview(
      htmlEmail({
        body: {
          type: "html",
          html: [
            "<p>First answer</p>",
            '<blockquote type="cite">Question</blockquote>',
            "<p>Second answer</p>",
          ].join(""),
        },
      }),
    );
    const quoteOnly = buildEmailPreview(
      htmlEmail({
        body: {
          type: "html",
          html: '<blockquote type="cite"><p>Only quoted content</p></blockquote>',
        },
      }),
    );

    expect(inlineReply.bodyFolds).toEqual([]);
    expect(inlineReply.bodyHtml).not.toContain("data-stella-email-fold=");
    expect(inlineReply.bodyHtml).toContain("Question");
    expect(quoteOnly.bodyFolds).toEqual([]);
    expect(quoteOnly.bodyHtml).not.toContain("data-stella-email-fold=");
    expect(quoteOnly.bodyHtml).toContain("Only quoted content");
  });

  test("creates one fold for nested quoted HTML", () => {
    const preview = buildEmailPreview(
      htmlEmail({
        body: {
          type: "html",
          html: '<p>Reply</p><div class="gmail_quote"><blockquote type="cite">Parent<blockquote type="cite">Child</blockquote></blockquote></div>',
        },
      }),
    );

    expect(preview.bodyFolds).toEqual([
      { id: "fold-0", kind: "quoted-history" },
    ]);
    expect(
      preview.bodyHtml.match(/data-stella-email-fold="quoted-history"/gu),
    ).toHaveLength(1);
    expect(preview.bodyHtml).toContain("Parent");
    expect(preview.bodyHtml).toContain("Child");
  });

  test("keeps fold markers expanded inside restricted table parents", () => {
    const tableBodies = [
      '<table><tbody class="gmail_quote"><tr><td>Section history</td></tr></tbody></table>',
      '<table><tbody><tr class="gmail_quote"><td>Row history</td></tr></tbody></table>',
      '<table><tbody><tr><td class="gmail_quote">Cell history</td></tr></tbody></table>',
    ];

    for (const html of tableBodies) {
      const preview = buildEmailPreview(
        htmlEmail({
          body: { type: "html", html: `<p>Reply</p>${html}` },
        }),
      );

      expect(preview.bodyFolds).toEqual([]);
      expect(preview.bodyHtml).not.toContain("<details");
      expect(preview.bodyHtml).toContain("history");
    }

    const flowContentInCell = buildEmailPreview(
      htmlEmail({
        body: {
          type: "html",
          html: '<p>Reply</p><table><tbody><tr><td><div class="gmail_quote">Nested history</div></td></tr></tbody></table>',
        },
      }),
    );
    expect(flowContentInCell.bodyFolds).toEqual([
      { id: "fold-0", kind: "quoted-history" },
    ]);
    expect(flowContentInCell.bodyHtml).toContain(
      '<td><details data-stella-email-fold="quoted-history">',
    );
  });

  test("folds only trailing plain-text quote runs and standard signatures", () => {
    const body = [
      "Aktuální odpověď",
      "",
      "-- ",
      "Žofie Nováková",
      "> Předchozí zpráva",
      "> Druhý řádek",
    ].join("\r\n");
    const preview = buildEmailPreview(
      htmlEmail({ body: { type: "text", text: body } }),
    );

    expect(preview.bodyFolds).toEqual([
      { id: "fold-0", kind: "signature" },
      { id: "fold-1", kind: "quoted-history" },
    ]);
    expect(preview.bodyHtml).toContain("Aktuální odpověď");
    expect(preview.bodyHtml).toContain("Žofie Nováková");
    expect(preview.bodyHtml).toContain("&gt; Předchozí zpráva");
    expect(
      parsedEmailToText(htmlEmail({ body: { type: "text", text: body } })),
    ).toContain("> Druhý řádek");
  });

  test("keeps nonstandard and nonterminal plain-text delimiters visible", () => {
    const nonstandardDelimiter = buildEmailPreview(
      htmlEmail({
        body: { type: "text", text: "Reply\n--\nNot a signature" },
      }),
    );
    const inlineQuote = buildEmailPreview(
      htmlEmail({
        body: { type: "text", text: "Reply\n> Question\nAnswer" },
      }),
    );

    expect(nonstandardDelimiter.bodyFolds).toEqual([]);
    expect(nonstandardDelimiter.bodyHtml).toContain("--");
    expect(inlineQuote.bodyFolds).toEqual([]);
    expect(inlineQuote.bodyHtml).toContain("&gt; Question");
  });

  test("keeps declared folds and generated markers in exact correspondence", () => {
    const bodies: ParsedEmail["body"][] = [
      {
        type: "html",
        html: '<p>Reply</p><div class="gmail_signature">Name</div>',
      },
      {
        type: "html",
        html: '<p>Reply</p><blockquote type="cite">History</blockquote>',
      },
      { type: "text", text: "Reply\n-- \nName\n> History" },
      { type: "text", text: "No folded content" },
    ];

    for (const body of bodies) {
      const preview = buildEmailPreview(htmlEmail({ body }));
      const markerIds = Array.from(
        preview.bodyHtml.matchAll(
          /data-stella-email-fold-summary="(?<id>fold-\d+)"/gu,
        ),
        (match) => match.groups?.["id"],
      );
      expect(markerIds).toEqual(preview.bodyFolds.map(({ id }) => id));
    }
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
    "--BND",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <evidence456>",
    'Content-Disposition: attachment; filename="evidence.png"',
    "",
    PNG_BASE64,
    "--BND--",
    "",
  ].join("\r\n");
  const svgInlineEml = [
    "From: Jane Lawyer <jane@example.com>",
    "To: client@example.org",
    "Subject: SVG CID",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="BND"',
    "",
    "--BND",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<html><body><img src="cid:logo123"></body></html>',
    "--BND",
    "Content-Type: image/svg+xml",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo123>",
    'Content-Disposition: inline; filename="logo.svg"',
    "",
    SVG_BASE64,
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

  test("does not inline related SVG images", async () => {
    const result = await emailToHtml(
      toArrayBuffer(svgInlineEml),
      "message/rfc822",
    );
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }

    expect(result.value).not.toContain("data:image/svg+xml");
    expect(result.value).not.toContain("cid:logo123");
    expect(result.value).not.toContain("<script");
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

  test("hides referenced inline images but preserves unreferenced CID attachments", async () => {
    const result = await emailToPreview(toArrayBuffer(eml), "message/rfc822");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }

    expect(result.value.attachments).toEqual([
      {
        id: "attachment-0",
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 16,
        previewable: false,
      },
      {
        id: "attachment-1",
        fileName: "evidence.png",
        mimeType: "image/png",
        sizeBytes: Buffer.from(PNG_BASE64, "base64").byteLength,
        previewable: true,
      },
    ]);
  });

  test("preserves internationalized recipients, Bcc, and a received date in preview metadata", async () => {
    const unicodeEml = [
      "From: Žofie Nováková <zofie@example.cz>",
      "To: 李雷 <li@example.cn>",
      "Cc: Renée <renee@example.fr>",
      "Bcc: عائشة <aisha@example.ae>",
      "Subject: Návrh smlouvy ⚖️",
      "Date: Tue, 02 Jun 2026 12:30:00 +0200",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Dobrý den",
    ].join("\r\n");

    const preview = buildEmailPreview(
      await parseEmail(toArrayBuffer(unicodeEml), "message/rfc822"),
    );

    expect(preview.from).toBe("Žofie Nováková <zofie@example.cz>");
    expect(preview.to).toEqual(["李雷 <li@example.cn>"]);
    expect(preview.cc).toEqual(["Renée <renee@example.fr>"]);
    expect(preview.bcc).toEqual(["عائشة <aisha@example.ae>"]);
    expect(preview.date).toBe("2026-06-02T10:30:00.000Z");
    expect(preview.bodyHtml).toContain("Dobrý den");
  });
});
