import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";
import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  type SourceRawObjectRef,
  type SourceRawObjects,
  type SourceRawParts,
} from "@/api/lib/legal-search/ingestion-types";

import {
  readSourceTextBaseline,
  type ReadSourceTextBaselineOptions,
} from "./source-input";
import { TEXT_ORACLE_LIMITS } from "./types";

const bytes = (text: string) => new TextEncoder().encode(text);
const pdfBytes = async (text: string) => {
  const pdf = PDF.create();
  pdf.addPage().drawText(text, { x: 20, y: 700 });
  return await pdf.save();
};
const binaryRef = (raw: Uint8Array) =>
  ({
    location: "case-law/raw/document/verified-object",
    sha256: new Bun.CryptoHasher("sha256").update(raw).digest("hex"),
    contentType: "application/pdf",
    byteLength: raw.byteLength,
  }) as const satisfies SourceRawObjectRef;

type SourceFixtureOptions = Omit<
  ReadSourceTextBaselineOptions,
  "raw" | "contentType"
> & {
  parts: SourceRawParts;
  objects?: SourceRawObjects;
};
const fromEnvelope = ({
  parts,
  objects,
  sourceKey,
  readBinary,
  binaryCache,
}: SourceFixtureOptions) =>
  readSourceTextBaseline({
    sourceKey,
    raw: bytes(encodeSourceRawEnvelope(parts, objects)),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    readBinary,
    binaryCache,
  });

const expectText = async (
  pending: ReturnType<typeof readSourceTextBaseline>,
  text: string,
) => {
  const result = await pending;
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value.text).toContain(text);
  return result.value.text;
};

describe("captured source transport resolution", () => {
  test("an envelope text recipe reads its document rather than listing metadata", async () => {
    const text = await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.CZ_NS,
        parts: {
          listing: "PRIVATE METADATA",
          print: "<unknown>decision repeated repeated</unknown>",
        },
      }),
      "decision",
    );
    expect(text).not.toContain("PRIVATE METADATA");
    expect(text.split("repeated")).toHaveLength(3);
  });

  test("XML dialect boundaries keep adjacent xPart texts separate", async () => {
    const text = await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.PL_UODO,
        parts: {
          "body-xml":
            "<xPart><xText>first</xText><xText>second</xText></xPart>",
        },
      }),
      "first",
    );
    expect(text).toMatch(/first\s+second/u);
  });

  test("hidden RTF is decoded before the HTML fallback and a failure cannot use the fallback", async () => {
    const text = await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.CZ_US,
        parts: {
          document:
            '<input id="docContentHidden" value="{\\rtf1 HIDDEN DECISION}"><p>VISIBLE FALLBACK</p>',
        },
      }),
      "HIDDEN DECISION",
    );
    expect(text).not.toContain("VISIBLE FALLBACK");
    const bad = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.CZ_US,
      parts: {
        document:
          '<input id="docContentHidden" value="{\\rtf1 malformed"><p>VISIBLE FALLBACK</p>',
      },
    });
    expect(bad.isErr() && bad.error.reason).toBe("malformed");
    await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.CZ_US,
        parts: {
          document:
            '<input id="docContentHidden" value=""><p>VISIBLE FALLBACK</p>',
        },
      }),
      "VISIBLE FALLBACK",
    );
  });

  test("base64 recipes honor the captured HU format discriminator", async () => {
    await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.HU_BHGY,
        parts: {
          document: Buffer.from(bytes("{\\rtf1 RTF SOURCE}")).toString(
            "base64",
          ),
          documentContentType: "application/rtf",
        },
      }),
      "RTF SOURCE",
    );
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX SOURCE</w:t></w:r></w:p></w:body></w:document>',
    );
    await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.HU_BHGY,
        parts: {
          document: Buffer.from(
            await zip.generateAsync({ type: "uint8array" }),
          ).toString("base64"),
          documentContentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
      "DOCX SOURCE",
    );
    const bad = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.HU_BHGY,
      parts: {
        document: "invalid$$base64",
        documentContentType: "application/rtf",
      },
    });
    expect(bad.isErr() && bad.error.reason).toBe("malformed");
    const unknown = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.HU_BHGY,
      parts: { document: "YQ==", documentContentType: "application/unknown" },
    });
    expect(unknown.isErr() && unknown.error.reason).toBe("unsupported");
  });

  test("JSON/base64 PDF capture keeps bytes upstream of any court filters", async () => {
    const raw = await pdfBytes("CAPTURED PDF TEXT");
    await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.PL_SN,
        parts: {
          document: JSON.stringify({
            raw: Buffer.from(raw).toString("base64"),
          }),
        },
      }),
      "CAPTURED PDF TEXT",
    );
    const bad = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.PL_SN,
      parts: { document: JSON.stringify({ raw: "YQ=invalid" }) },
    });
    expect(bad.isErr() && bad.error.reason).toBe("malformed");
  });

  test("JSON representation alternatives never duplicate fulltext with sections", async () => {
    const full = await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.PL_NSA,
        parts: {
          row: JSON.stringify({
            full_text: "same repeated repeated",
            thesis: "same repeated repeated",
            sentence: null,
          }),
        },
      }),
      "same",
    );
    expect(full.split("repeated")).toHaveLength(3);
    const sections = await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.PL_NSA,
        parts: {
          row: JSON.stringify({
            full_text: null,
            thesis: "thesis",
            sentence: "sentence",
            reasons_for_judgment: null,
          }),
        },
      }),
      "thesis",
    );
    expect(sections).toContain("sentence");
    const malformed = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.PL_NSA,
      parts: {
        row: JSON.stringify({ full_text: [], thesis: "safe-looking fallback" }),
      },
    });
    expect(malformed.isErr() && malformed.error.reason).toBe("malformed");
  });

  test("structured JSON arrays preserve every occurrence and reject partially missing paths", async () => {
    const text = await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.CZ_REGIONAL,
        parts: {
          document: JSON.stringify({
            header: [{ texts: [{ text: "repeated" }, { text: "repeated" }] }],
            verdict: [{ texts: [{ text: "verdict" }] }],
            verdictText: "duplicate fallback",
          }),
        },
      }),
      "verdict",
    );
    expect(text.split("repeated")).toHaveLength(3);
    expect(text).not.toContain("duplicate fallback");
    const malformed = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.CZ_REGIONAL,
      parts: {
        document: JSON.stringify({
          header: [{ texts: [{ text: "kept" }, {}] }],
        }),
      },
    });
    expect(malformed.isErr() && malformed.error.reason).toBe("malformed");
  });

  test("keyed JSON text inspects the source field value without reading identifiers", async () => {
    const text = await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.PL_KIS,
        parts: {
          detail: JSON.stringify({
            dokument: {
              fields: [
                { key: "IDENTIFIER", value: "DO NOT COUNT" },
                { key: "TRESC_INTERESARIUSZ", value: "<p>KEYED SOURCE</p>" },
              ],
            },
          }),
        },
      }),
      "KEYED SOURCE",
    );
    expect(text).not.toContain("DO NOT COUNT");
    const duplicate = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.PL_KIS,
      parts: {
        detail: JSON.stringify({
          dokument: {
            fields: [
              { key: "TRESC_INTERESARIUSZ", value: "one" },
              { key: "TRESC_INTERESARIUSZ", value: "two" },
            ],
          },
        }),
      },
    });
    expect(duplicate.isErr() && duplicate.error.reason).toBe("malformed");
  });

  test("opinion candidates share transport precedence, dispatch on structure and preserve distinct opinions", async () => {
    const opinions = [
      opinionRow({
        xml_harvard: "<opinion><p>XML SOURCE</p></opinion>",
        plain_text: "duplicate weaker text",
      }),
      opinionRow({
        id: "2",
        xml_harvard: "",
        html_with_citations: "<opinion><p>XML IN HTML COLUMN</p></opinion>",
      }),
      opinionRow({ id: "3", xml_harvard: "", html: "<p>HTML SOURCE</p>" }),
      opinionRow({ id: "4", xml_harvard: "", plain_text: "PLAIN SOURCE" }),
    ];
    const text = await expectText(
      fromEnvelope({
        sourceKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
        parts: { "cl-opinions": JSON.stringify(opinions) },
      }),
      "XML SOURCE",
    );
    for (const part of ["XML IN HTML COLUMN", "HTML SOURCE", "PLAIN SOURCE"]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("duplicate weaker text");
    const scan = await fromEnvelope({
      sourceKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      parts: {
        "cl-opinions": JSON.stringify([
          opinionRow({ xml_harvard: "", xml_scan: "<scan/>" }),
        ]),
      },
    });
    expect(scan.isErr() && scan.error.reason).toBe("unsupported");
    const malformed = await fromEnvelope({
      sourceKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      parts: {
        "cl-opinions": JSON.stringify([
          opinionRow({
            xml_harvard: "<broken>",
            plain_text: "weaker fallback",
          }),
        ]),
      },
    });
    expect(malformed.isErr() && malformed.error.reason).toBe("malformed");
  });

  test("binary cache hits require matching fingerprints and cause zero additional reads", async () => {
    const raw = await pdfBytes("VERIFIED CACHED SOURCE");
    const ref = binaryRef(raw);
    let reads = 0;
    const binaryCache = new Map([[ref.location, raw]]);
    const options = {
      sourceKey: ADAPTER_KEYS.SK_US,
      parts: {},
      objects: { "document-file": ref },
      binaryCache,
      readBinary: async () => {
        reads += 1;
        return raw;
      },
    } as const satisfies SourceFixtureOptions;
    await expectText(fromEnvelope(options), "VERIFIED CACHED SOURCE");
    expect(reads).toBe(0);
    const mismatch = await fromEnvelope({
      ...options,
      objects: { "document-file": { ...ref, sha256: "0".repeat(64) } },
    });
    expect(mismatch.isErr() && mismatch.error.reason).toBe("malformed");
    expect(reads).toBe(0);
  });

  test("numbered object families inspect every part once and cannot skip missing or corrupt parts", async () => {
    const first = await pdfBytes("FIRST SOURCE PAGE");
    const second = await pdfBytes("SECOND SOURCE PAGE");
    const firstRef = binaryRef(first);
    const secondRef = {
      ...binaryRef(second),
      location: "case-law/raw/document/second-object",
    };
    const calls: string[] = [];
    const readBinary = async (location: string) => {
      calls.push(location);
      return location === firstRef.location ? first : second;
    };
    const text = await expectText(
      fromEnvelope({
        sourceKey: ADAPTER_KEYS.PL_UOKIK,
        parts: {},
        objects: { "decision-file": firstRef, "decision-file-2": secondRef },
        readBinary,
      }),
      "FIRST SOURCE PAGE",
    );
    expect(text).toContain("SECOND SOURCE PAGE");
    expect(calls).toEqual([firstRef.location, secondRef.location]);
    const gap = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.PL_UOKIK,
      parts: {},
      objects: { "decision-file-2": secondRef },
      readBinary,
    });
    expect(gap.isErr() && gap.error.reason).toBe("unavailable");
    const broken = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.PL_UOKIK,
      parts: {},
      objects: {
        "decision-file": firstRef,
        "decision-file-2": {
          ...secondRef,
          byteLength: secondRef.byteLength + 1,
        },
      },
      readBinary,
    });
    expect(broken.isErr() && broken.error.reason).toBe("malformed");
  });

  test("missing binaries and reader failures remain unavailable; oversized references never fetch", async () => {
    const raw = await pdfBytes("STORED SOURCE");
    const ref = binaryRef(raw);
    const missing = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.SK_US,
      parts: {},
      objects: { "document-file": ref },
      readBinary: async () => null,
    });
    expect(missing.isErr() && missing.error.reason).toBe("unavailable");
    const failed = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.SK_US,
      parts: {},
      objects: { "document-file": ref },
      readBinary: async () => {
        throw new TypeError("injected storage failure");
      },
    });
    expect(failed.isErr() && failed.error.reason).toBe("unavailable");
    let fetched = false;
    const over = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.SK_US,
      parts: {},
      objects: {
        "document-file": {
          ...ref,
          byteLength: TEXT_ORACLE_LIMITS.rawBytes + 1,
        },
      },
      readBinary: async () => {
        fetched = true;
        return raw;
      },
    });
    expect(over.isErr() && over.error.reason).toBe("resource_limit");
    expect(fetched).toBe(false);
  });

  test("historical SK listing captures are unavailable while retained direct PDFs are assessable", async () => {
    const missing = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.SK_COURTS,
      parts: { listing: "{}", detail: "{}" },
    });
    expect(missing.isErr() && missing.error.reason).toBe("unavailable");
    const raw = await pdfBytes("DEFERRED SK SOURCE");
    await expectText(
      readSourceTextBaseline({
        sourceKey: ADAPTER_KEYS.SK_COURTS,
        raw,
        contentType: "application/pdf",
      }),
      "DEFERRED SK SOURCE",
    );
  });

  test("legacy source shapes are declared, and malformed envelopes cannot become an empty baseline", async () => {
    await expectText(
      readSourceTextBaseline({
        sourceKey: ADAPTER_KEYS.CZ_US,
        raw: bytes("<p>LEGACY SOURCE</p>"),
        contentType: "text/html",
      }),
      "LEGACY SOURCE",
    );
    await expectText(
      readSourceTextBaseline({
        sourceKey: ADAPTER_KEYS.CZ_REGIONAL,
        raw: bytes(JSON.stringify({ verdictText: "LEGACY JSON SOURCE" })),
        contentType: "application/json",
      }),
      "LEGACY JSON SOURCE",
    );
    await expectText(
      readSourceTextBaseline({
        sourceKey: ADAPTER_KEYS.AT_COURTS,
        raw: bytes(
          JSON.stringify({
            listing: {},
            documentXml:
              "<risdok><nutzdaten><absatz>LEGACY RIS</absatz></nutzdaten></risdok>",
          }),
        ),
        contentType: "application/json",
      }),
      "LEGACY RIS",
    );
    const malformed = await readSourceTextBaseline({
      sourceKey: ADAPTER_KEYS.SK_US,
      raw: bytes(
        JSON.stringify({
          version: 1,
          parts: {},
          objects: { "document-file": {} },
        }),
      ),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    });
    expect(malformed.isErr() && malformed.error.reason).toBe("malformed");
    const unsupported = await readSourceTextBaseline({
      sourceKey: ADAPTER_KEYS.CZ_NS,
      raw: bytes("<p>unregistered legacy</p>"),
      contentType: "text/html",
    });
    expect(unsupported.isErr() && unsupported.error.reason).toBe("unsupported");
    const empty = await fromEnvelope({
      sourceKey: ADAPTER_KEYS.CZ_NS,
      parts: { print: "<p></p>" },
    });
    expect(empty.isErr() && empty.error.reason).toBe("unavailable");
  });
});
