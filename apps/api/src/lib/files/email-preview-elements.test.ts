import { describe, expect, test } from "bun:test";
import { load } from "cheerio";

import {
  type ParsedEmail,
  renderEmailBodyHtml,
  renderEmailHtml,
} from "@/api/lib/files/email-to-html";

const PARSER_DIVERGENT_ELEMENTS = [
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "template",
  "iframe",
] as const;

const REMOTE_URL = "https://preview-resource.invalid/item";

const htmlEmail = (html: string): ParsedEmail => ({
  subject: null,
  from: null,
  to: [],
  cc: [],
  bcc: [],
  date: null,
  body: { type: "html", html },
  inlineImages: [],
  attachments: [],
});

const textEmail = (): ParsedEmail => ({
  ...htmlEmail(""),
  body: { type: "text", text: "Message body" },
});

const expectCanonicalDocument = (html: string): void => {
  const $ = load(html);
  expect(
    $("head")
      .children()
      .first()
      .is("meta[http-equiv='Content-Security-Policy']"),
  ).toBe(true);
  expect($.html()).not.toContain(REMOTE_URL);
};

describe("email preview elements", () => {
  test.each(PARSER_DIVERGENT_ELEMENTS)(
    "renders %s content within the preview document policy",
    (element) => {
      const attributes =
        element === "iframe" ? ` srcdoc='<img src="${REMOTE_URL}">'` : "";
      const source = `<html><head><${element}${attributes}><img src="${REMOTE_URL}"><style>@import url(${REMOTE_URL})</style></${element}></head><body><p>Message body</p></body></html>`;
      const parsed = htmlEmail(source);

      expectCanonicalDocument(renderEmailHtml(parsed));
      expectCanonicalDocument(renderEmailBodyHtml(parsed));
    },
  );

  test("places the preview document policy first for every render path", () => {
    const renderPaths = [
      renderEmailHtml(htmlEmail("<p>Message body</p>")),
      renderEmailHtml(textEmail()),
      renderEmailBodyHtml(htmlEmail("<p>Message body</p>")),
      renderEmailBodyHtml(textEmail()),
    ];

    for (const rendered of renderPaths) {
      expectCanonicalDocument(rendered);
    }
  });
});
