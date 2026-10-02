import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toPlainTextMetadataObject } from "@/api/lib/case-law/plain-text";
import { sanitizeMetadata } from "@/api/lib/legal-search/corpus-sanitize";
import {
  approveMetadataUrls,
  MAX_METADATA_URL_DIAGNOSTICS,
  metadataUrlAddresses,
  metadataUrlKeys,
  opaqueMetadataValue,
  rehydrateMetadataUrls,
} from "@/api/lib/legal-search/metadata-urls";
import { MetadataUrlDefect, toMetadataUrl } from "@/api/lib/sanitize-url";
import { isRecord } from "@/api/lib/type-guards";

const SCHEMA = { url: "url", documents: { items: { href: "url" } } } as const;

const jsonReload = (value: unknown): unknown => {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized);
};

test("source schemas require every constructed URL branch without accepting raw or widened strings", () => {
  const raw = { url: "https://example.test/?a=&amp;", documents: [] };
  // @ts-expect-error Declared source URLs require the constructor.
  approveMetadataUrls(raw, SCHEMA);
  const widened: Record<string, unknown> = raw;
  // @ts-expect-error Widening cannot erase source provenance.
  approveMetadataUrls(widened, { url: "url" });
  // @ts-expect-error An object cannot be declared as a URL scalar.
  approveMetadataUrls({ url: {} }, { url: "url" });
  const source = {
    url: toMetadataUrl(raw.url, "transport-json"),
    documents: [{ href: toMetadataUrl(raw.url, "decoded") }],
  };
  // @ts-expect-error Constructed root URLs cannot be omitted from the schema.
  approveMetadataUrls(source, { documents: SCHEMA.documents });
  // @ts-expect-error Constructed nested URL branches cannot be omitted.
  approveMetadataUrls(source, { url: "url", documents: { items: {} } });
  expect(() => {
    // @ts-expect-error Scalar URL arrays have no metadata contract.
    approveMetadataUrls(
      { urls: [toMetadataUrl(raw.url, "decoded")] },
      { urls: { items: "url" } },
    );
  }).toThrow("Scalar URL arrays have no metadata schema contract");
  approveMetadataUrls({ display: undefined, other: null }, {});
  expect({
    value: toPlainTextMetadataObject(
      rehydrateMetadataUrls(raw, SCHEMA),
      SCHEMA,
    ).unwrap()["url"],
  }).toHaveProperty("value", raw.url);
});

test("static declarations survive spread, structuredClone, JSON, and repeated projection", () => {
  const approved = approveMetadataUrls(
    {
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
    },
    SCHEMA,
  );
  const expected = {
    url: "https://example.test/?a=&amp;lt;p&amp;gt;",
    documents: [
      { href: "https://example.test/?b=&#x26;", title: "Court & tribunal" },
    ],
    title: "Judgment & reasons",
    unknownUrl: "opaque text",
  };
  for (const copy of [
    { ...approved },
    structuredClone(approved),
    rehydrateMetadataUrls(jsonReload(approved), SCHEMA),
  ]) {
    const projected = toPlainTextMetadataObject(copy, SCHEMA).unwrap();
    expect({ value: projected }).toHaveProperty("value", expected);
    expect(toPlainTextMetadataObject(projected, SCHEMA).unwrap()).toEqual(
      projected,
    );
    expect(Object.getOwnPropertySymbols(projected)).toEqual([]);
  }
  expect(metadataUrlKeys(SCHEMA).has("url")).toBe(true);
  expect(metadataUrlAddresses(SCHEMA)).toEqual(["url", "documents[*].href"]);
  expect({
    value: toPlainTextMetadataObject(approved).unwrap()["url"],
  }).not.toHaveProperty("value", expected.url);
});

test("invalid approval diagnostics survive cloned approved metadata and storage without exposing URL text", () => {
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
  const expected = {
    documents: [{}],
    metadataUrlDiagnostics: {
      entries: [
        { address: "url", reason: "unsafe-protocol" },
        { address: "documents[0].href", reason: "control-character" },
      ],
      overflowCount: 0,
    },
  };
  expect(approved).toEqual(expected);
  expect(JSON.stringify(approved)).not.toContain("private-invalid-value");
  const clone = structuredClone(approved);
  const first = sanitizeMetadata(
    toPlainTextMetadataObject(clone, SCHEMA).unwrap(),
  );
  const second = sanitizeMetadata(
    toPlainTextMetadataObject(
      rehydrateMetadataUrls(jsonReload(first), SCHEMA),
      SCHEMA,
    ).unwrap(),
  );
  expect(first).toEqual(expected);
  expect(second).toEqual(first);
});

test("stated nulls stay null and empty URL strings are absent without a defect", () => {
  const schema = {
    sourceUrl: "url",
    documents: { items: { href: "url" } },
  } as const;
  const approved = approveMetadataUrls(
    {
      sourceUrl: toMetadataUrl(null, "decoded"),
      documents: [
        { href: toMetadataUrl(null, "decoded") },
        { href: toMetadataUrl("", "decoded") },
      ],
    },
    schema,
  );
  expect(approved).toEqual({
    sourceUrl: null,
    documents: [{ href: null }, {}],
  });
  expect({
    value: toPlainTextMetadataObject(approved, schema).unwrap(),
  }).toHaveProperty("value", approved);
  expect(toMetadataUrl(undefined, "transport-json")).toBeUndefined();
  expect(toMetadataUrl("  ", "constructed")).toBeUndefined();
});

test("all production transports preserve entities and dangerous URL characters produce exact defects", () => {
  const raw = "https://example.test/?a=&amp;amp;&b=&amp;lt;p&amp;gt;";
  for (const encoding of [
    "transport-json",
    "decoded",
    "constructed",
  ] as const) {
    expect({ value: toMetadataUrl(raw, encoding) }).toHaveProperty(
      "value",
      raw,
    );
  }
  expect({
    value: toMetadataUrl(" \nhttps://example.test/\t ", "decoded"),
  }).toHaveProperty("value", "https://example.test/");
  const defect = toMetadataUrl("https://example.test/a\u200Bb", "decoded");
  expect(defect).toBeInstanceOf(MetadataUrlDefect);
  expect(defect).toMatchObject({ reason: "control-character" });
});

test("fresh source approval recomputes diagnostics instead of merging stale stored sidecars", () => {
  const approved = approveMetadataUrls(
    {
      url: toMetadataUrl("https://example.test/new", "decoded"),
      documents: [],
      metadataUrlDiagnostics: {
        entries: [{ address: "url", reason: "unsafe-protocol" }],
        overflowCount: 0,
      },
    },
    SCHEMA,
  );
  expect(approved).toEqual({ url: "https://example.test/new", documents: [] });
  expect(
    rehydrateMetadataUrls(
      {
        ...approved,
        metadataUrlDiagnostics: {
          entries: [{ address: "url", reason: "unsafe-protocol" }],
          overflowCount: 0,
        },
      },
      SCHEMA,
    ),
  ).toEqual(approved);
});

test("diagnostics are bounded under one reserved key and retain their overflow through JSON", () => {
  const approved = approveMetadataUrls(
    {
      url: undefined,
      documents: Array.from(
        { length: MAX_METADATA_URL_DIAGNOSTICS + 4 },
        () => ({ href: toMetadataUrl("ftp://example.test/", "decoded") }),
      ),
    },
    SCHEMA,
  );
  const diagnostics = approved["metadataUrlDiagnostics"];
  if (!isRecord(diagnostics) || !Array.isArray(diagnostics["entries"])) {
    throw new TypeError("Expected diagnostic sidecar");
  }
  expect(diagnostics["entries"]).toHaveLength(MAX_METADATA_URL_DIAGNOSTICS);
  expect(
    diagnostics["entries"].every(
      (entry) =>
        isRecord(entry) &&
        typeof entry["address"] === "string" &&
        entry["reason"] === "unsafe-protocol",
    ),
  ).toBe(true);
  expect(diagnostics["overflowCount"]).toBe(4);
  expect({
    value: toPlainTextMetadataObject(
      rehydrateMetadataUrls(jsonReload(approved), SCHEMA),
      SCHEMA,
    ).unwrap(),
  }).toHaveProperty("value", approved);
  expect(Object.keys(approved)).toEqual([
    "documents",
    "metadataUrlDiagnostics",
  ]);
});

test("hostile persisted overflow counts saturate safely and reach a JSON fixed point", () => {
  const stored = {
    documents: Array.from({ length: MAX_METADATA_URL_DIAGNOSTICS + 4 }, () => ({
      href: "ftp://example.test/",
    })),
    metadataUrlDiagnostics: {
      entries: [],
      overflowCount: Number.MAX_SAFE_INTEGER,
    },
  };
  const first = rehydrateMetadataUrls(stored, SCHEMA);
  const sidecar = first["metadataUrlDiagnostics"];
  expect(sidecar).toMatchObject({ overflowCount: Number.MAX_SAFE_INTEGER });
  expect(rehydrateMetadataUrls(jsonReload(first), SCHEMA)).toEqual(first);
});

test("stored diagnostic sidecars validate homogeneous entries and safe overflow counts", () => {
  for (const sidecar of [
    [],
    { entries: "bad", overflowCount: 3 },
    { entries: [], overflowCount: -1 },
    { entries: [], overflowCount: 1.5 },
  ]) {
    expect(
      rehydrateMetadataUrls(
        { documents: [], metadataUrlDiagnostics: sidecar },
        SCHEMA,
      ),
    ).toEqual({ documents: [] });
  }
  const projected = rehydrateMetadataUrls(
    {
      documents: [],
      metadataUrlDiagnostics: {
        entries: [
          null,
          { overflowCount: 9 },
          { address: "missing", reason: "made-up" },
          { address: "missing", reason: "invalid-url" },
        ],
        overflowCount: 2,
      },
    },
    SCHEMA,
  );
  expect(projected).toEqual({
    documents: [],
    metadataUrlDiagnostics: {
      entries: [{ address: "missing", reason: "invalid-url" }],
      overflowCount: 2,
    },
  });
  expect(rehydrateMetadataUrls(jsonReload(projected), SCHEMA)).toEqual(
    projected,
  );
});

test("malformed stored arrays and objects produce bounded defects, with stable mixed-array addresses", () => {
  expect(
    rehydrateMetadataUrls({ url: {}, documents: "bad shape" }, SCHEMA),
  ).toEqual({
    metadataUrlDiagnostics: {
      entries: [
        { address: "url", reason: "unsupported-url-value" },
        { address: "documents", reason: "unsupported-url-value" },
      ],
      overflowCount: 0,
    },
  });
  const first = rehydrateMetadataUrls(
    {
      documents: [
        { href: "https://example.test/?a=&amp;" },
        "bad shape",
        { href: "ftp://example.test/" },
      ],
    },
    SCHEMA,
  );
  expect(first).toEqual({
    documents: [{ href: "https://example.test/?a=&amp;" }, null, {}],
    metadataUrlDiagnostics: {
      entries: [
        { address: "documents[1]", reason: "unsupported-url-value" },
        { address: "documents[2].href", reason: "unsafe-protocol" },
      ],
      overflowCount: 0,
    },
  });
  expect({
    value: toPlainTextMetadataObject(
      rehydrateMetadataUrls(jsonReload(first), SCHEMA),
      SCHEMA,
    ).unwrap(),
  }).toHaveProperty("value", first);
});

test("opaque source branches unwrap before storage without interpreting wrapper-shaped persisted JSON", () => {
  const schema = {
    chamber: { object: { href: "url" }, preserve: "opaque" },
  } as const;
  const chamberBranch = (kind: "valid" | "opaque") =>
    kind === "valid"
      ? { href: toMetadataUrl("https://example.test/?q=&amp;", "decoded") }
      : opaqueMetadataValue("Izba");
  const chamber = chamberBranch("opaque");
  // @ts-expect-error Opaque alternatives cannot erase the constructed object branch.
  approveMetadataUrls(
    { chamber },
    { chamber: { object: {}, preserve: "opaque" } },
  );
  expect(approveMetadataUrls({ chamber }, schema)).toEqual({ chamber: "Izba" });
  const publisherObject = { type: "metadata-url-opaque", value: "Izba" };
  const stored = rehydrateMetadataUrls({ chamber: publisherObject }, schema);
  expect(stored).toEqual({ chamber: publisherObject });
  expect({
    value: toPlainTextMetadataObject(
      rehydrateMetadataUrls(jsonReload(stored), schema),
      schema,
    ).unwrap(),
  }).toHaveProperty("value", stored);
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
          toPlainTextMetadataObject(approved, SCHEMA).unwrap(),
        );
        const second = sanitizeMetadata(
          toPlainTextMetadataObject(
            rehydrateMetadataUrls(jsonReload(first), SCHEMA),
            SCHEMA,
          ).unwrap(),
        );
        expect(first["url"]).toEqual(url);
        expect(second).toEqual(first);
      },
    ),
  );
});
