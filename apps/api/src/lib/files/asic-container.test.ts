import { describe, expect, test } from "bun:test";

import {
  ASIC_E_FILE_FORMAT,
  ASIC_S_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import { ZipArchive } from "@stll/docx-core/zip";

import { readAsicContainer } from "@/api/lib/files/asic-container";
import { makeAsicFixture } from "@/api/tests/fixtures/asic";

const EXTENDED = ASIC_E_FILE_FORMAT.mimeType;
const SIMPLE = ASIC_S_FILE_FORMAT.mimeType;

const zipWithEntries = async (
  entries: Record<string, string>,
  compression: "store" | "deflate" = "store",
) => {
  const zip = new ZipArchive();
  for (const [name, bytes] of Object.entries(entries)) {
    zip.set(name, bytes);
  }
  return await zip.generate({ compression });
};

const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const EOCD_LENGTH = 22;
const LOWERCASE_A = 0x61;
const LOWERCASE_X = 0x78;

const entryHeaders = (bytes: Uint8Array, name: string) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - EOCD_LENGTH;
  const start = view.getUint32(end + 16, true);
  for (let at = start; at < end;) {
    const length = view.getUint16(at + 28, true);
    const nameAt = at + CENTRAL_HEADER_LENGTH;
    if (
      Buffer.from(bytes.subarray(nameAt, nameAt + length)).toString() === name
    ) {
      return { view, central: at, local: view.getUint32(at + 42, true) };
    }
    at =
      nameAt +
      length +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  throw new TypeError(`Missing fixture entry ${name}`);
};

describe("reading ASiC containers", () => {
  test.each(["xades", "cades", "timestamp"] as const)(
    "ASiC-E returns all document paths and bytes with %s metadata",
    async (signature) => {
      const members = [
        { fileName: "brief.txt", bytes: "Original brief" },
        {
          fileName: "přílohy/annex.txt",
          bytes: "Long annex content. ".repeat(100),
        },
      ];
      const container = await makeAsicFixture({ members, signature });

      const result = await readAsicContainer(container, EXTENDED);

      expect(
        result.unwrap().members.map(({ fileName, bytes }) => ({
          fileName,
          bytes: new TextDecoder().decode(bytes),
        })),
      ).toEqual(members);
    },
  );

  test("ASiC-S returns the one payload without unpacking a contained ZIP", async () => {
    const bytes = await zipWithEntries({ "file.txt": "original content" });
    const container = await makeAsicFixture({
      mimeType: SIMPLE,
      members: [{ fileName: "documents.zip", bytes }],
    });

    const result = await readAsicContainer(container, SIMPLE);

    expect(result.unwrap().members).toEqual([
      { fileName: "documents.zip", bytes },
    ]);
  });

  test.each([EXTENDED, SIMPLE])(
    "recognizes unambiguous ZIP evidence without a mimetype for %s",
    async (expected) => {
      const container = await makeAsicFixture({
        mimeType: expected,
        mimeTypeEntry: "omit",
        signature: "cades",
      });
      const mismatch = expected === EXTENDED ? SIMPLE : EXTENDED;

      expect((await readAsicContainer(container, expected)).isOk()).toBe(true);
      expect((await readAsicContainer(container, mismatch)).isErr()).toBe(true);
    },
  );

  test("does not use the requested type to resolve ambiguity when mimetype is absent", async () => {
    const container = await makeAsicFixture({
      mimeType: SIMPLE,
      mimeTypeEntry: "omit",
    });

    expect((await readAsicContainer(container, SIMPLE)).isErr()).toBe(true);
    expect((await readAsicContainer(container, EXTENDED)).isErr()).toBe(true);
  });

  test("requires the profile declared in the mimetype to match the requested one", async () => {
    const container = await makeAsicFixture({ mimeType: EXTENDED });

    expect((await readAsicContainer(container, SIMPLE)).isErr()).toBe(true);
  });

  test("reads the bounded MIME label in legacy archives that compress it", async () => {
    const container = await zipWithEntries(
      {
        "META-INF/signature001.p7s": "fixture",
        "META-INF/ASiCManifest.xml": "<fixture/>",
        "document.txt": "content",
        mimetype: EXTENDED,
      },
      "deflate",
    );
    const { view, central } = entryHeaders(container, "mimetype");
    expect(view.getUint16(central + 10, true)).toBe(8);

    expect((await readAsicContainer(container, EXTENDED)).isOk()).toBe(true);
  });

  test.each([EXTENDED, SIMPLE])(
    "rejects ZIPs without ASiC evidence for %s",
    async (mimeType) => {
      const plain = await zipWithEntries({ "document.txt": "plain ZIP" });
      const markerOnly = await zipWithEntries({
        mimetype: mimeType,
        "document.txt": "ZIP without signature or time assertion",
      });

      expect((await readAsicContainer(plain, mimeType)).isErr()).toBe(true);
      expect((await readAsicContainer(markerOnly, mimeType)).isErr()).toBe(
        true,
      );
    },
  );

  test.each([
    { fileNames: ["first.txt", "second.txt"], reason: "multiple files" },
    { fileNames: ["folder/first.txt"], reason: "a nested path" },
    { fileNames: [], reason: "no payload" },
  ])("ASiC-S rejects $reason", async ({ fileNames }) => {
    const container = await makeAsicFixture({
      mimeType: SIMPLE,
      members: fileNames.map((fileName) => ({ fileName, bytes: "content" })),
    });

    expect((await readAsicContainer(container, SIMPLE)).isErr()).toBe(true);
  });

  test.each([
    ["a.txt", "A.txt"],
    ["é.txt", "e\u0301.txt"],
    ["Přílohy/local.txt", "přílohy/another.txt"],
    ["path", "path/leaf.txt"],
  ])("rejects ambiguous paths %s and %s", async (first, second) => {
    const container = await makeAsicFixture({
      members: [
        { fileName: first, bytes: "first" },
        { fileName: second, bytes: "second" },
      ],
    });

    expect((await readAsicContainer(container, EXTENDED)).isErr()).toBe(true);
  });

  test("rejects duplicated entry names even when both ZIP headers agree", async () => {
    const container = await makeAsicFixture({
      members: [
        { fileName: "a.txt", bytes: "first" },
        { fileName: "b.txt", bytes: "second" },
      ],
    });
    const { central, local } = entryHeaders(container, "b.txt");
    container[central + CENTRAL_HEADER_LENGTH] = LOWERCASE_A;
    container[local + LOCAL_HEADER_LENGTH] = LOWERCASE_A;

    expect((await readAsicContainer(container, EXTENDED)).isErr()).toBe(true);
  });

  test("rejects a disagreement between the local and central entry names", async () => {
    const container = await makeAsicFixture();
    const { local } = entryHeaders(container, "document.txt");
    container[local + LOCAL_HEADER_LENGTH] = LOWERCASE_X;

    expect((await readAsicContainer(container, EXTENDED)).isErr()).toBe(true);
  });

  test("rejects contained bytes that disagree with the indexed CRC", async () => {
    const container = await zipWithEntries({
      mimetype: EXTENDED,
      "document.txt": "contained text",
      "META-INF/signatures0.xml": "<fixture/>",
    });
    expect((await readAsicContainer(container, EXTENDED)).isOk()).toBe(true);
    const { view, local } = entryHeaders(container, "document.txt");
    const contentAt =
      local +
      LOCAL_HEADER_LENGTH +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    container[contentAt] = LOWERCASE_X;

    expect((await readAsicContainer(container, EXTENDED)).isErr()).toBe(true);
  });

  test("bounds ZIP inventory before decompressing payloads", async () => {
    const container = await makeAsicFixture({
      members: Array.from({ length: 1001 }, (_, index) => ({
        fileName: `doc-${index}.txt`,
        bytes: "content",
      })),
    });

    const result = await readAsicContainer(container, EXTENDED);

    expect(result).toMatchObject({ error: { reason: "limit" } });
  });

  test("refuses inflated bytes beyond a payload's ZIP budget", async () => {
    const container = await makeAsicFixture({
      members: [
        { fileName: "contents.txt", bytes: "compressible. ".repeat(1000) },
      ],
    });
    const { view, local, central } = entryHeaders(container, "contents.txt");
    expect(view.getUint16(central + 10, true)).toBe(8);
    view.setUint32(local + 22, 12, true);
    view.setUint32(central + 24, 12, true);

    expect((await readAsicContainer(container, EXTENDED)).isErr()).toBe(true);
  });
});
