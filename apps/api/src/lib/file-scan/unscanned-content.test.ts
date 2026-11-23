/**
 * The upload scan every path shares (matter uploads from web, mobile, MCP and
 * the CLI, chat attachments, email and data-box filing, parts saved to a
 * matter) stores an archive whose entries cannot be read, with a warning per
 * reason, and still refuses one whose readable content is malware.
 */
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ASIC_FILE_FORMATS } from "@stll/api-contract/asic-file-formats";
import {
  UNSCANNED_CONTENT_WARNING,
  unscannedContentReasons,
} from "@stll/api-contract/file-scan-warnings";

import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import { eicarTestFile } from "@/api/tests/fixtures/eicar";
import { makeZipArchive } from "@/api/tests/fixtures/zip-archive";
import type { RawZipEntry } from "@/api/tests/fixtures/zip-archive";

const ENCRYPTED_FLAG = 0x00_01;
const WINZIP_AES = 99;
const LZMA = 14;

/** Every container read through the shared ZIP inspection. */
const CONTAINERS = [
  { name: "bundle.zip", mimeType: "application/zip" },
  { name: "bundle.zip", mimeType: "application/x-zip-compressed" },
  ...ASIC_FILE_FORMATS.map(({ extensions, mimeType }) => ({
    name: `container${extensions[0]}`,
    mimeType,
  })),
  { name: "invoice.isdocx", mimeType: "application/x-isdocx" },
] as const;

const encrypted = (name: string): RawZipEntry => ({
  name,
  data: "Client correspondence",
  flags: ENCRYPTED_FLAG,
});

const upload = async (
  entries: readonly RawZipEntry[],
  { name, mimeType }: { name: string; mimeType: string },
) =>
  await scanUpload({
    bytes: makeZipArchive(entries),
    declaredMimeType: mimeType,
    fileName: name,
  });

describe.each(CONTAINERS)("a $mimeType upload", (container) => {
  test("with an encrypted entry is stored with the encrypted warning", async () => {
    const scanned = Result.unwrap(
      await upload(
        [encrypted("letters/locked.pdf"), { name: "readme.txt", data: "Hi" }],
        container,
      ),
    );

    expect(scanned.scanWarnings).toEqual([UNSCANNED_CONTENT_WARNING.encrypted]);
    expect(unscannedContentReasons(scanned.scanWarnings)).toEqual([
      "encrypted",
    ]);
  });

  test("with WinZip AES and LZMA entries carries both reasons", async () => {
    const scanned = Result.unwrap(
      await upload(
        [
          { name: "a.pdf", data: "x", method: WINZIP_AES },
          { name: "b.pdf", data: "y", method: LZMA },
        ],
        container,
      ),
    );

    expect(unscannedContentReasons(scanned.scanWarnings)).toEqual([
      "encrypted",
      "unsupportedCompression",
    ]);
  });

  test("with an encrypted entry beside readable malware is refused", async () => {
    const scanned = await upload(
      [
        encrypted("letters/locked.pdf"),
        // Deflated, so only the inspection of the entries can find it.
        { name: "tools/readme.txt", data: eicarTestFile(), method: 8 },
      ],
      container,
    );

    if (!Result.isError(scanned) || !FileScanRejectedError.is(scanned.error)) {
      throw new TypeError("expected the scan to refuse the file");
    }
    expect(scanned.error.rejection.issues.map(({ code }) => code)).toContain(
      "eicar_test_file",
    );
  });

  test("whose entries are all readable carries no warning", async () => {
    const scanned = Result.unwrap(
      await upload([{ name: "readme.txt", data: "Hi" }], container),
    );

    expect(scanned.scanWarnings).toBeNull();
  });
});
