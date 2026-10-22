import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { detectChatLinks, normalizeChatLink } from "./link-detection";

const label = fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/u);
const domain = fc
  .tuple(label, fc.constantFrom("com", "app", "cz", "org", "dev", "technology"))
  .map(([name, suffix]) => `${name}.${suffix}`);

describe("chat link detection", () => {
  test("detects ICANN domains, www domains and international hostnames", () => {
    const input = "www.stll.app stll.app github.com https://例え.jp/a";
    expect(detectChatLinks(input).map(({ hostname }) => hostname)).toEqual([
      "www.stll.app",
      "stll.app",
      "github.com",
      "xn--r8jz45g.jp",
    ]);
  });

  test("keeps balanced path punctuation and trims surrounding prose", () => {
    expect(
      detectChatLinks("See (https://en.wikipedia.org/wiki/Test_(law))."),
    ).toEqual([
      {
        start: 5,
        end: 45,
        text: "https://en.wikipedia.org/wiki/Test_(law)",
        href: "https://en.wikipedia.org/wiki/Test_(law)",
        hostname: "en.wikipedia.org",
      },
    ]);
  });

  test("keeps citations, filenames, addresses, special-use names and paths plain", () => {
    for (const text of [
      "§ 1.2",
      "1.2.3",
      "report.zip",
      "video.mov",
      "file.pdf",
      "bundle.js",
      "user@example.com",
      "user@stll.app",
      "foo.invalid",
      "foo.test",
      "ftp://stll.app",
      "//stll.app",
      "/path/stll.app",
      "C:\\path\\stll.app",
      "mailto:user@stll.app",
    ]) {
      expect(detectChatLinks(text)).toEqual([]);
    }
    expect(detectChatLinks("www.report.zip https://report.zip")).toHaveLength(
      2,
    );
  });

  test("rejects credentials, executable schemes and invisible characters", () => {
    expect(detectChatLinks("https://publisher.example.test")).toHaveLength(1);
    for (const input of [
      "https://user:pass@stll.app",
      // oxlint-disable-next-line no-script-url -- Adversarial parser input verifies executable URLs are rejected.
      "javascript:alert(1)",
      "data:text/html,test",
      "https://stll.app/\npath",
      "https://stll.app/\u200bpath",
      "https://stll.app\\evil",
    ]) {
      expect(normalizeChatLink(input)).toBeNull();
    }
    expect(
      detectChatLinks("https://user@stll.app https://user:pass@stll.app"),
    ).toEqual([]);
  });

  test("relative destinations are never interpreted as bare domains", () => {
    for (const input of [
      "/github.com/stella",
      "//github.com/stella",
      "./github.com/stella",
      "../github.com/stella",
      ".github.com/stella",
      "\\github.com/stella",
      "github.com\\stella",
      "ftp://github.com/stella",
      "https:github.com/stella",
    ]) {
      expect(normalizeChatLink(input)).toBeNull();
    }
  });

  test("root-relative and dot-relative destinations never become external origins", () => {
    assertProperty(
      "root-relative and dot-relative destinations never become external origins",
      fc.property(
        fc.constantFrom("/", "//", "/./", "/../", ".", "..", "./", "../"),
        fc.oneof(
          fc.string(),
          domain.map((host) => `${host}/stella`),
        ),
        (prefix, suffix) => {
          expect(normalizeChatLink(`${prefix}${suffix}`)).toBeNull();
        },
      ),
    );
  });

  test("chat link spans preserve text and remain ordered, safe and stable", () => {
    assertProperty(
      "chat link spans preserve text and remain ordered, safe and stable",
      fc.property(
        fc.array(fc.oneof(fc.string(), domain), { maxLength: 30 }),
        (pieces) => {
          const input = pieces.join(" ");
          let end = 0;
          for (const span of detectChatLinks(input)) {
            expect(span.start).toBeGreaterThanOrEqual(end);
            expect(span.end).toBeGreaterThan(span.start);
            expect(input.slice(span.start, span.end)).toBe(span.text);
            const url = new URL(span.href);
            expect(["http:", "https:"]).toContain(url.protocol);
            expect(url.username).toBe("");
            expect(url.password).toBe("");
            expect(normalizeChatLink(span.href)).toEqual({
              href: span.href,
              hostname: span.hostname,
            });
            end = span.end;
          }
        },
      ),
    );
  });

  test("chat links preserve Unicode prefix offsets and valid bare-domain destinations", () => {
    assertProperty(
      "chat links preserve Unicode prefix offsets and valid bare-domain destinations",
      fc.property(fc.string(), domain, (prefix, host) => {
        const input = `${prefix}\n${host}!`;
        const span = detectChatLinks(input).find(
          ({ start }) => start === prefix.length + 1,
        );
        expect(span).toEqual({
          start: prefix.length + 1,
          end: prefix.length + 1 + host.length,
          text: host,
          href: `https://${host}/`,
          hostname: host,
        });
      }),
    );
  });

  test("chat links reject the ambiguous filename and numeric citation classes", () => {
    assertProperty(
      "chat links reject the ambiguous filename and numeric citation classes",
      fc.property(
        label,
        fc.constantFrom("zip", "mov", "pdf", "docx", "txt", "js"),
        fc.nat(),
        fc.nat(),
        (name, suffix, first, second) => {
          expect(
            detectChatLinks(`${name}.${suffix} § ${first}.${second}`),
          ).toEqual([]);
        },
      ),
    );
  });

  test("chat links never expose a truncated credential-bearing URL", () => {
    assertProperty(
      "chat links never expose a truncated credential-bearing URL",
      fc.property(label, label, domain, (username, password, host) => {
        expect(
          detectChatLinks(`https://${username}:${password}@${host}/path`),
        ).toEqual([]);
        expect(detectChatLinks(`https://${username}@${host}/path`)).toEqual([]);
      }),
    );
  });
});
