import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { load } from "cheerio";
import { isTag } from "domhandler";
import fc from "fast-check";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  EmailParseError,
  emailToHtml,
  parseEmail,
  sanitizeEmailBodyHtml,
} from "./email-to-html";

const scheme = fc.constantFrom("javascript", "vbscript", "data");
const url = fc
  .tuple(scheme, fc.constantFrom("", "\t", "\n", "&#x09;"), fc.boolean())
  .map(([protocol, gap, upper]) => {
    const mixed = upper ? protocol.toUpperCase() : protocol;
    return `${mixed.slice(0, 2)}${gap}${mixed.slice(2)}:text/html,test`;
  });
const fragment = fc.oneof(
  fc.string({ maxLength: 256 }),
  url.map((value) => `<a href="${value}" onclick="test()">link</a>`),
  url.map((value) => `<img src="${value}" onerror="test()">`),
  fc.constantFrom(
    '<ScRiPt>test()</ScRiPt><p onmouseover="test()">text</p>',
    '<svg><a xlink:href="&#106;avascript:test()">link</a></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=test()>">',
    '<div><p><a href="&#x6a;avascript:test()">text</div></a>',
    '<img src="data:image/png;base64,AA=="><p>text</p>',
  ),
);
const html = fc
  .array(fragment, { maxLength: 8 })
  .map((fragments) => fragments.join(""));

const assertPassiveHtml = (output: string) => {
  const $ = load(output);
  expect($("script").length).toBe(0);
  $("*").each((_, element) => {
    if (!isTag(element)) {
      return;
    }
    for (const [name, value] of Object.entries(element.attribs)) {
      expect(name.toLowerCase().startsWith("on")).toBe(false);
      if (
        ![
          "href",
          "src",
          "action",
          "formaction",
          "poster",
          "background",
          "xlink:href",
          "ping",
          "srcset",
        ].includes(name.toLowerCase())
      ) {
        continue;
      }
      if (!URL.canParse(value, "https://example.test")) {
        continue;
      }
      const protocol = new URL(value, "https://example.test").protocol;
      expect(
        ["javascript", "vbscript"].map((schemeName) => `${schemeName}:`),
      ).not.toContain(protocol);
      if (protocol === "data:") {
        expect(value).toMatch(
          /^data:image\/(?:png|jpe?g|gif|webp|bmp|tiff);base64,/iu,
        );
      }
    }
  });
};

const nestedMime = (depth: number) => {
  const parts = ["From: sender@example.test\r\n"];
  for (let index = 0; index < depth; index++) {
    parts.push(
      `Content-Type: multipart/mixed; boundary="b${index}"\r\n\r\n--b${index}\r\n`,
    );
  }
  parts.push("Content-Type: text/plain\r\n\r\ntext\r\n");
  for (let index = depth - 1; index >= 0; index--) {
    parts.push(`--b${index}--\r\n`);
  }
  return new TextEncoder().encode(parts.join(""));
};
const eml = fc.oneof(
  fc.uint8Array({ maxLength: 4096 }),
  fc.integer({ min: 0, max: 270 }).map(nestedMime),
  html.map((body) =>
    new TextEncoder().encode(
      `From: sender@example.test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`,
    ),
  ),
  fc
    .array(
      fc.record({
        offset: fc.integer({ min: 0, max: 511 }),
        value: fc.integer({ min: 0, max: 255 }),
      }),
      { maxLength: 16 },
    )
    .map((mutations) => {
      const bytes = nestedMime(4);
      for (const { offset, value } of mutations) {
        if (offset < bytes.length) {
          bytes[offset] = value;
        }
      }
      return bytes;
    }),
);

describe("email body HTML properties", () => {
  test(
    "reparsed output contains passive content",
    () => {
      fc.assert(
        fc.property(html, (input) => {
          assertPassiveHtml(sanitizeEmailBodyHtml(input));
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "sanitizing reaches a fixed point",
    () => {
      fc.assert(
        fc.property(html, (input) => {
          const once = sanitizeEmailBodyHtml(input);
          expect(sanitizeEmailBodyHtml(once)).toBe(once);
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "arbitrary and mutated MIME produces typed failures within budget",
    async () => {
      await fc.assert(
        fc.asyncProperty(eml, async (bytes) => {
          const start = performance.now();
          const result = await Result.tryPromise({
            try: async () =>
              await parseEmail(new Uint8Array(bytes).buffer, EML_MIME_TYPE),
            catch: (error) => error,
          });
          expect(performance.now() - start).toBeLessThan(2000);
          if (result.isErr()) {
            expect(result.error).toBeInstanceOf(EmailParseError);
            return;
          }
          expect(["html", "text"]).toContain(result.value.body.type);
        }),
        propertyConfig({ seed: propertySeed(), numRuns: 50 }),
      );
    },
    propertyTestTimeout(15_000),
  );

  test(
    "MIME limit failures preserve their cause through HTML conversion",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 257, max: 270 }), async (depth) => {
          const bytes = nestedMime(depth);
          const parsed = await Result.tryPromise({
            try: async () => await parseEmail(bytes.buffer, EML_MIME_TYPE),
            catch: (error) => error,
          });
          expect(parsed.isErr()).toBe(true);
          if (parsed.isErr()) {
            expect(parsed.error).toBeInstanceOf(EmailParseError);
            if (parsed.error instanceof EmailParseError) {
              expect(parsed.error.cause).toBeInstanceOf(Error);
              expect(parsed.error.cause).not.toBeInstanceOf(EmailParseError);
            }
          }
          const rendered = await emailToHtml(bytes.buffer, EML_MIME_TYPE);
          expect(rendered.isErr()).toBe(true);
          if (rendered.isErr()) {
            expect(rendered.error).toBeInstanceOf(EmailParseError);
            expect(rendered.error.cause).toBeInstanceOf(Error);
            expect(rendered.error.cause).not.toBeInstanceOf(EmailParseError);
          }
        }),
        propertyConfig({ seed: propertySeed(), numRuns: 5 }),
      );
    },
    propertyTestTimeout(15_000),
  );

  test(
    "HTML email conversion emits passive content",
    async () => {
      await fc.assert(
        fc.asyncProperty(html, async (body) => {
          const bytes = new TextEncoder().encode(
            `From: sender@example.test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`,
          );
          const rendered = await emailToHtml(bytes.buffer, EML_MIME_TYPE);
          expect(rendered.isOk()).toBe(true);
          if (rendered.isOk()) {
            assertPassiveHtml(rendered.value);
          }
        }),
        propertyConfig({ seed: propertySeed(), numRuns: 50 }),
      );
    },
    propertyTestTimeout(15_000),
  );
});
