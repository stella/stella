import { describe, expect, test } from "bun:test";
import { isTag } from "domhandler";

import { load } from "@stll/html";

import {
  EMAIL_PREVIEW_DOM_OPTIONS,
  type ParsedEmail,
  renderEmailBodyHtml,
  renderEmailHtml,
  serializeEmailPreviewMarkup,
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
const NOSCRIPT_BODY =
  '<body><noscript>&lt;a href="https://preview-resource.invalid/"&gt;Open&lt;/a&gt;</noscript></body>';

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
  const $ = load(html, { scriptingEnabled: false });
  expect(
    $("head")
      .children()
      .first()
      .is("meta[http-equiv='Content-Security-Policy']"),
  ).toBe(true);
  expect($.html()).not.toContain(REMOTE_URL);
  $("*").each((_, element) => {
    if (!isTag(element)) {
      return;
    }
    for (const value of Object.values(element.attribs)) {
      expect(value).not.toContain(REMOTE_URL);
    }
  });
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

  test("keeps preview markup consistent between parsing and output", () => {
    const parsed = htmlEmail(NOSCRIPT_BODY);

    for (const rendered of [
      renderEmailHtml(parsed),
      renderEmailBodyHtml(parsed),
    ]) {
      const $ = load(rendered, { scriptingEnabled: false });
      expect($("a[href^='https://preview-resource.invalid/']")).toHaveLength(0);
      expect(rendered).not.toContain("https://preview-resource.invalid/");
    }

    const $ = load(NOSCRIPT_BODY, EMAIL_PREVIEW_DOM_OPTIONS);
    expect(serializeEmailPreviewMarkup($)).toContain("&lt;a href=");
    expect(Object.isFrozen(EMAIL_PREVIEW_DOM_OPTIONS)).toBe(true);
  });

  test("uses one document mode for email preview parsing and output", async () => {
    const source = await Bun.file(
      new URL("email-to-html.ts", import.meta.url),
    ).text();

    expect(source.match(/(?<![A-Za-z])load\(/gu) ?? []).toHaveLength(1);
    expect(source).toContain("load(html, EMAIL_PREVIEW_DOM_OPTIONS)");
    expect(source.match(/\.html\(/gu) ?? []).toHaveLength(0);
    expect(source.match(/(?<![A-Za-z])serializeOuter\(/gu) ?? []).toHaveLength(
      2,
    );
    expect(source).toContain("serializeOuter(html, EMAIL_PREVIEW_DOM_OPTIONS)");
    expect(source).toContain("serializeOuter(node, EMAIL_PREVIEW_DOM_OPTIONS)");
  });

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
