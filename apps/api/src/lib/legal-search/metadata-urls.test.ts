import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toPlainTextMetadataObject } from "@/api/lib/case-law/plain-text";
import { sanitizeMetadata } from "@/api/lib/legal-search/corpus-sanitize";
import {
  approveMetadataUrls,
  metadataUrlAddresses,
  metadataUrlKeys,
  preserveMetadataUrlDeclarations,
  rehydrateMetadataUrls,
} from "@/api/lib/legal-search/metadata-urls";
import { MetadataUrlDefect, toMetadataUrl } from "@/api/lib/sanitize-url";

const SCHEMA = { url: "url", documents: { items: { href: "url" } } } as const;

test("source approval requires constructed URL leaves, while reload explicitly validates persisted strings", () => {
  const raw = { url: "https://example.test/?a=&amp;", documents: [] };
  // @ts-expect-error A source URL requires the shared constructor, not a raw string.
  approveMetadataUrls(raw, SCHEMA);
  const widened: Record<string, unknown> = raw;
  // @ts-expect-error Widening source metadata cannot erase the constructor requirement.
  approveMetadataUrls(widened, { url: "url" });
  // @ts-expect-error An empty object is not a constructed URL scalar.
  approveMetadataUrls({ url: {} }, { url: "url" });
  const restored = rehydrateMetadataUrls(raw, SCHEMA);
  expect(toPlainTextMetadataObject(restored).unwrap()["url"]).toBe(raw.url);
});

test("only declared URLs bypass text projection, with scalar JSON and declarations preserved on copies", () => {
  const source = {
    url: toMetadataUrl(
      "https://example.test/?a=&amp;lt;p&amp;gt;",
      "transport-json",
    ),
    documents: [
      {
        href: toMetadataUrl("https://example.test/?b=&#x26;", "decoded"),
        title: "<b>Court</b> &amp; tribunal",
      },
    ],
    title: "<i>Judgment</i> &amp; reasons",
    unknownUrl: "&lt;b&gt;opaque text&lt;/b&gt;",
  };
  const approved = approveMetadataUrls(source, SCHEMA);
  const copied = preserveMetadataUrlDeclarations(approved, { ...approved });
  const projected = toPlainTextMetadataObject(copied).unwrap();
  expect(projected).toEqual({
    url: "https://example.test/?a=&amp;lt;p&amp;gt;",
    documents: [
      { href: "https://example.test/?b=&#x26;", title: "Court & tribunal" },
    ],
    title: "Judgment & reasons",
    unknownUrl: "opaque text",
  });
  expect(toPlainTextMetadataObject(projected).unwrap()).toEqual(projected);
  expect(metadataUrlKeys(projected).has("url")).toBe(true);
  expect(metadataUrlAddresses(projected)).toEqual(["url", "documents[*].href"]);
  const serialized = JSON.stringify(projected);
  expect(JSON.parse(serialized)).toEqual(projected);
  expect(Object.keys(projected)).toEqual([
    "url",
    "documents",
    "title",
    "unknownUrl",
  ]);
});

test("invalid declared leaves are omitted with one sibling diagnostics array containing no URL text", () => {
  const approved = approveMetadataUrls(
    {
      url: toMetadataUrl(
        "ftp://example.test/private-invalid-value",
        "constructed",
      ),
      documents: [
        {
          href: toMetadataUrl("https://example.test/pri\u0000vate", "decoded"),
        },
      ],
    },
    SCHEMA,
  );
  expect(approved).toEqual({
    documents: [{}],
    metadataUrlDiagnostics: [
      { address: "url", reason: "unsafe-protocol" },
      { address: "documents[0].href", reason: "control-character" },
    ],
  });
  expect(JSON.stringify(approved)).not.toContain("private-invalid-value");
  const stored = sanitizeMetadata(toPlainTextMetadataObject(approved).unwrap());
  const serialized = JSON.stringify(stored);
  const reloaded: unknown = JSON.parse(serialized);
  expect(
    sanitizeMetadata(
      toPlainTextMetadataObject(
        rehydrateMetadataUrls(reloaded, SCHEMA),
      ).unwrap(),
    ),
  ).toEqual(stored);
  expect(
    metadataUrlAddresses(
      approveMetadataUrls({ url: undefined, documents: [] }, SCHEMA),
    ),
  ).toEqual(["url", "documents[*].href"]);
});

test("raw HTML is decoded once, transport strings and parsed attributes are never decoded again", () => {
  const raw = "https://example.test/?a=&amp;amp;&b=&amp;lt;p&amp;gt;";
  expect(toMetadataUrl(raw, "raw-html")).toBe(
    "https://example.test/?a=&amp;&b=&lt;p&gt;",
  );
  for (const encoding of [
    "transport-json",
    "decoded",
    "constructed",
  ] as const) {
    expect(toMetadataUrl(raw, encoding)).toBe(raw);
  }
  expect(toMetadataUrl(" \nhttps://example.test/\t ", "decoded")).toBe(
    "https://example.test/",
  );
  expect(
    toMetadataUrl("https://example.test/a\u200Bb", "decoded"),
  ).toBeInstanceOf(MetadataUrlDefect);
});

test("declared metadata URLs have a reload projection storage fixed point", () => {
  assertProperty(
    "declared metadata URLs have a reload projection storage fixed point",
    fc.property(
      fc.array(
        fc.constantFrom(
          "&",
          "%26",
          "&amp;",
          "&#38;",
          "&#x26;",
          "%26amp%3B",
          "&amp;lt;p&amp;gt;",
          "<p>",
        ),
        { minLength: 1, maxLength: 8 },
      ),
      (pieces) => {
        const url = `https://example.test/document?a=${pieces.join("")}`;
        const approved = approveMetadataUrls(
          { url: toMetadataUrl(url, "transport-json"), documents: [] },
          SCHEMA,
        );
        const first = sanitizeMetadata(
          toPlainTextMetadataObject(approved).unwrap(),
        );
        const serialized = JSON.stringify(first);
        const persisted: unknown = JSON.parse(serialized);
        const second = sanitizeMetadata(
          toPlainTextMetadataObject(
            rehydrateMetadataUrls(persisted, SCHEMA),
          ).unwrap(),
        );
        expect(first["url"]).toBe(url);
        expect(second).toEqual(first);
      },
    ),
  );
});

test("storage deep clones retain nested declarations and a changed approved scalar fails", () => {
  const approved = approveMetadataUrls(
    {
      url: toMetadataUrl("https://example.test/?a=&amp;", "transport-json"),
      documents: [
        {
          href: toMetadataUrl(
            "https://example.test/?b=&amp;lt;p&amp;gt;",
            "transport-json",
          ),
        },
      ],
    },
    SCHEMA,
  );
  const clone = preserveMetadataUrlDeclarations(
    approved,
    sanitizeMetadata(approved),
  );
  expect(toPlainTextMetadataObject(clone).unwrap()).toEqual(approved);
  expect(() =>
    preserveMetadataUrlDeclarations(approved, {
      ...approved,
      url: "https://example.test/changed",
    }),
  ).toThrow("Approved metadata URL changed during metadata copying");
});

test("a fresh independently approved subtree may replace replayed URLs", () => {
  const stored = rehydrateMetadataUrls(
    {
      url: "https://example.test/binding",
      documents: [{ href: "https://example.test/old" }],
    },
    SCHEMA,
  );
  const notice = approveMetadataUrls(
    {
      documents: [
        { href: toMetadataUrl("https://example.test/new", "decoded") },
      ],
    },
    { documents: SCHEMA.documents },
  );
  const merged = preserveMetadataUrlDeclarations(
    stored,
    preserveMetadataUrlDeclarations(notice, { ...stored, ...notice }),
  );
  expect(toPlainTextMetadataObject(merged).unwrap()).toEqual({
    url: "https://example.test/binding",
    documents: [{ href: "https://example.test/new" }],
  });
});

test("reload omits a missing URL leaf while preserving a null optional container", () => {
  expect(rehydrateMetadataUrls({ url: null, documents: null }, SCHEMA)).toEqual(
    { documents: null },
  );
});
