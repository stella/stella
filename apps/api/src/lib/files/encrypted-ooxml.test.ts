import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import { scanFile } from "@/api/lib/file-scan/scan";
import { detectFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  isEncryptedOoxmlContainer,
  OOXML_MIME_TYPES,
  probeEncryptedOoxml,
} from "@/api/lib/files/encrypted-ooxml";
import {
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

import { buildCompoundFile } from "./compound-file.test-fixture";
import type { CompoundFileFixtureStream } from "./compound-file.test-fixture";

/**
 * Real password-protected packages: minimal DOCX/XLSX/PPTX zips (no document
 * properties) encrypted with the password "fixture" by msoffcrypto-tool
 * (agile encryption, as Office 2010+ writes it). They are stored with a
 * `.cfb` extension because their Office metadata cannot be read back.
 */
const REAL_FIXTURES = [
  { format: "docx", mimeType: DOCX_MIME_TYPE },
  { format: "xlsx", mimeType: XLSX_MIME_TYPE },
  { format: "pptx", mimeType: PPTX_MIME_TYPE },
] as const;

const readFixture = async (format: string): Promise<Uint8Array> =>
  new Uint8Array(
    await Bun.file(
      path.join(
        import.meta.dir,
        "__fixtures__",
        `password-protected-${format}.cfb`,
      ),
    ).arrayBuffer(),
  );

const stream = (
  streamPath: string[],
  bytes: Uint8Array = new Uint8Array([1, 2, 3, 4]),
): CompoundFileFixtureStream => ({ path: streamPath, bytes });

/** The container Office writes around an encrypted package. */
const encryptedContainer = (): Uint8Array =>
  buildCompoundFile([
    stream(["\u0006DataSpaces", "Version"]),
    stream(["EncryptionInfo"]),
    stream(["EncryptedPackage"], new Uint8Array(256).fill(7)),
  ]);

const scannedAs = (mimeType: string, bytes: Uint8Array) =>
  testScannedFile({ bytes: bytes.slice().buffer, mimeType });

describe("probeEncryptedOoxml", () => {
  for (const { format, mimeType } of REAL_FIXTURES) {
    test(`recognizes a password-protected ${format}`, async () => {
      const bytes = await readFixture(format);

      expect(probeEncryptedOoxml(bytes)).toEqual({ status: "encrypted" });
      const detection = await detectFileEncryption({
        mimeType,
        scanned: scannedAs(mimeType, bytes),
      });
      expect(detection.status).toBe("known");
      expect(detection.encryption.encrypted).toBe(true);
      expect(detection.encryption.basis).toBe("inspected");
    });
  }

  test("recognizes the container under every OOXML type", async () => {
    const bytes = encryptedContainer();
    for (const mimeType of OOXML_MIME_TYPES) {
      const detection = await detectFileEncryption({
        mimeType,
        scanned: scannedAs(mimeType, bytes),
      });
      expect(detection.encryption.encrypted).toBe(true);
    }
  });

  test("needs both encryption streams in the root storage", () => {
    expect(
      probeEncryptedOoxml(buildCompoundFile([stream(["EncryptionInfo"])])),
    ).toEqual({ status: "not-encrypted" });
    expect(
      probeEncryptedOoxml(buildCompoundFile([stream(["EncryptedPackage"])])),
    ).toEqual({ status: "not-encrypted" });
    expect(
      probeEncryptedOoxml(
        buildCompoundFile([
          stream(["Nested", "EncryptionInfo"]),
          stream(["Nested", "EncryptedPackage"]),
        ]),
      ),
    ).toEqual({ status: "not-encrypted" });
  });

  test("does not read a legacy binary Word file as encrypted", () => {
    const legacyDoc = buildCompoundFile([
      stream(["WordDocument"]),
      stream(["1Table"]),
      stream(["\u0005SummaryInformation"]),
    ]);

    expect(probeEncryptedOoxml(legacyDoc)).toEqual({ status: "not-encrypted" });
  });

  test("reads a malformed container as not encrypted", () => {
    const headerOnly = encryptedContainer().slice(0, 512);
    const truncated = encryptedContainer().slice(0, 1100);

    expect(probeEncryptedOoxml(headerOnly)).toEqual({
      status: "not-encrypted",
    });
    expect(probeEncryptedOoxml(truncated)).toEqual({ status: "not-encrypted" });
  });

  test("ends on a directory whose siblings link back to themselves", () => {
    const bytes = encryptedContainer();
    // Root entry (directory sector 0, entry 0) -> child; point the first
    // child's right sibling back at itself.
    const view = new DataView(bytes.buffer);
    const directoryOffset = 512;
    const firstChild = view.getUint32(directoryOffset + 76, true);
    view.setUint32(directoryOffset + firstChild * 128 + 72, firstChild, true);

    expect(probeEncryptedOoxml(bytes).status).not.toBe("unsure");
  });

  test("is unsure when storages nest past the reader's depth limit", async () => {
    const deepPath = Array.from({ length: 40 }, (_, index) => `S${index}`);
    const bytes = buildCompoundFile([
      stream(["EncryptionInfo"]),
      stream(["EncryptedPackage"]),
      stream([...deepPath, "Leaf"]),
    ]);

    expect(probeEncryptedOoxml(bytes).status).toBe("unsure");
    // Like an unfinished PDF inspection: kept, recorded unencrypted.
    const detection = await detectFileEncryption({
      mimeType: DOCX_MIME_TYPE,
      scanned: scannedAs(DOCX_MIME_TYPE, bytes),
    });
    expect(detection.status).toBe("unsure");
    expect(detection.encryption.encrypted).toBe(false);
  });

  test("does not inspect bytes declared as another type", () => {
    expect(
      isEncryptedOoxmlContainer("application/pdf", encryptedContainer()),
    ).toBe(false);
    expect(
      isEncryptedOoxmlContainer(DOCX_MIME_TYPE, encryptedContainer()),
    ).toBe(true);
  });
});

describe("upload scan", () => {
  for (const { format, mimeType } of REAL_FIXTURES) {
    test(`accepts a password-protected ${format} under its declared type`, async () => {
      const result = await scanFile({
        buffer: await readFixture(format),
        declaredMimeType: mimeType,
        fileName: `fixture.${format}`,
      });

      expect(result.isOk()).toBe(true);
      const scan = result.unwrap();
      expect(scan.verdict).not.toBe("reject");
      expect(scan.findings.map((finding) => finding.rule)).not.toContain(
        "corrupt-zip",
      );
    });
  }

  test("still refuses a non-zip Office upload that is not an encrypted container", async () => {
    const result = await scanFile({
      buffer: buildCompoundFile([stream(["WordDocument"])]),
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: "fixture.docx",
    });

    expect(result.unwrap()).toMatchObject({
      verdict: "reject",
      findings: [{ rule: "corrupt-zip" }],
    });
  });

  test("refuses an encrypted container declared as a plain zip", async () => {
    const result = await scanFile({
      buffer: encryptedContainer(),
      declaredMimeType: "application/zip",
      fileName: "fixture.zip",
    });

    expect(result.unwrap().verdict).toBe("reject");
  });
});

const ooxmlPartName = fc
  .array(fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/u), {
    minLength: 1,
    maxLength: 3,
  })
  .map((segments) => `${segments.join("/")}.xml`);

const ooxmlZip = fc
  .record({
    parts: fc.dictionary(ooxmlPartName, fc.string({ maxLength: 200 }), {
      maxKeys: 6,
    }),
    // Encryption stream names as zip entries must not confuse the probe.
    withDecoyNames: fc.boolean(),
  })
  .map(async ({ parts, withDecoyNames }) => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    for (const [name, content] of Object.entries(parts)) {
      zip.file(name, content);
    }
    if (withDecoyNames) {
      zip.file("EncryptionInfo", "decoy");
      zip.file("EncryptedPackage", "decoy");
    }
    return await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
  });

describe("properties", () => {
  test("an OOXML zip is never flagged encrypted", async () => {
    await assertProperty(
      "an OOXML zip is never flagged encrypted",
      fc.asyncProperty(
        ooxmlZip,
        fc.constantFrom(...OOXML_MIME_TYPES),
        async (zipBytes, mimeType) => {
          const bytes = await zipBytes;
          expect(probeEncryptedOoxml(bytes)).toEqual({
            status: "not-encrypted",
          });
          const detection = await detectFileEncryption({
            mimeType,
            scanned: scannedAs(mimeType, bytes),
          });
          expect(detection).toMatchObject({
            status: "known",
            encryption: { encrypted: false },
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  test("bytes without the CFB signature are never flagged encrypted", () => {
    assertProperty(
      "bytes without the CFB signature are never flagged encrypted",
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        fc.pre(bytes[0] !== 0xd0);
        expect(probeEncryptedOoxml(bytes)).toEqual({
          status: "not-encrypted",
        });
      }),
      { numRuns: 300 },
    );
  });

  test("a damaged encrypted container never throws and never reads past its bytes", () => {
    const container = encryptedContainer();
    assertProperty(
      "a damaged encrypted container never throws and never reads past its bytes",
      fc.property(
        fc.array(
          fc.record({
            at: fc.nat({ max: container.byteLength - 1 }),
            value: fc.integer({ min: 0, max: 255 }),
          }),
          { minLength: 1, maxLength: 16 },
        ),
        fc.nat({ max: container.byteLength }),
        (edits, keepBytes) => {
          const bytes = container.slice(0, Math.max(keepBytes, 8));
          for (const { at, value } of edits) {
            // Keep the signature so the reader, not the prefix check, runs.
            if (at >= 8 && at < bytes.byteLength) {
              bytes[at] = value;
            }
          }
          const probe = probeEncryptedOoxml(bytes);
          // Malformed or limited parses are typed outcomes, never a defect.
          if (probe.status === "unsure") {
            expect(probe.cause.name).toBe("CompoundFileParseError");
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test("a container is encrypted exactly when its root holds both streams", () => {
    const streamName = fc.constantFrom(
      "EncryptionInfo",
      "EncryptedPackage",
      "WordDocument",
      "Workbook",
      "\u0006DataSpaces",
      "Other",
    );
    assertProperty(
      "a container is encrypted exactly when its root holds both streams",
      fc.property(
        fc.uniqueArray(
          fc.record({
            storage: fc.option(fc.constantFrom("A", "B"), { nil: undefined }),
            name: streamName,
          }),
          {
            selector: ({ storage, name }) => `${storage ?? ""}/${name}`,
            maxLength: 8,
          },
        ),
        (entries) => {
          const bytes = buildCompoundFile(
            entries.map(({ storage, name }) =>
              stream(storage === undefined ? [name] : [storage, name]),
            ),
          );
          const rootNames = new Set(
            entries
              .filter(({ storage }) => storage === undefined)
              .map(({ name }) => name),
          );
          const expected =
            rootNames.has("EncryptionInfo") && rootNames.has("EncryptedPackage")
              ? "encrypted"
              : "not-encrypted";
          expect(probeEncryptedOoxml(bytes).status).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});
