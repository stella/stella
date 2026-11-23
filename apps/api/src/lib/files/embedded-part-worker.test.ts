import { describe, expect, test } from "bun:test";

import { FILE_PART_KINDS } from "@stll/api-contract/file-parts";
import {
  ASIC_E_FILE_FORMAT,
  DATA_BOX_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";

import { makeAsicFixture } from "@/api/tests/fixtures/asic";
import { FIXTURE_MESSAGE, zfoFile } from "@/api/tests/fixtures/zfo";

import {
  decodeEmbeddedPart,
  encodeEmbeddedPart,
} from "./embedded-part-protocol";
import { containerOf, extractEmbeddedPart } from "./embedded-part-worker";

const read = async (
  fileBytes: Uint8Array,
  containerMimeType: string,
  kind: (typeof FILE_PART_KINDS)[keyof typeof FILE_PART_KINDS],
  index: number,
) => {
  const result = await extractEmbeddedPart({
    fileBytes,
    containerMimeType,
    containerName: "container",
    zipNameCodePage: "ibm437",
    part: { kind, index },
  });
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
};

describe("a part read from a stored container", () => {
  test("an ASiC member is its exact bytes, in the container's order", async () => {
    const container = await makeAsicFixture({
      members: [
        { fileName: "lisa.txt", bytes: "Töölepingu lisa" },
        { fileName: "teine.txt", bytes: "Teine dokument" },
      ],
    });
    const second = await read(
      container,
      ASIC_E_FILE_FORMAT.mimeType,
      FILE_PART_KINDS.member,
      1,
    );
    expect(second?.fileName).toBe("teine.txt");
    expect(new TextDecoder().decode(second?.bytes)).toBe("Teine dokument");
    expect(
      await read(
        container,
        ASIC_E_FILE_FORMAT.mimeType,
        FILE_PART_KINDS.member,
        2,
      ),
    ).toBeNull();
  });

  test("a data-box file keeps its name, and its bytes name its type", async () => {
    const message = await zfoFile();
    const [pdf, text] = FIXTURE_MESSAGE.files;
    const first = await read(
      message,
      DATA_BOX_FILE_FORMAT.mimeType,
      FILE_PART_KINDS.attachment,
      0,
    );
    expect(first?.fileName).toBe(pdf?.name);
    expect(first?.mimeType).toBe("application/pdf");
    expect(
      Buffer.from(first?.bytes ?? []).equals(Buffer.from(pdf?.content ?? [])),
    ).toBe(true);
    const second = await read(
      message,
      DATA_BOX_FILE_FORMAT.mimeType,
      FILE_PART_KINDS.attachment,
      1,
    );
    expect(second?.fileName).toBe(text?.name);
    expect(new TextDecoder().decode(second?.bytes)).toBe(
      "Synthetic instructions.",
    );
  });

  test("a part kind the container does not have names nothing", async () => {
    const container = await makeAsicFixture();
    expect(
      await read(
        container,
        ASIC_E_FILE_FORMAT.mimeType,
        FILE_PART_KINDS.attachment,
        0,
      ),
    ).toBeNull();
    expect(
      await read(
        await zfoFile(),
        DATA_BOX_FILE_FORMAT.mimeType,
        FILE_PART_KINDS.member,
        0,
      ),
    ).toBeNull();
  });

  test("an unreadable container is an error, not an empty part", async () => {
    const result = await extractEmbeddedPart({
      fileBytes: new TextEncoder().encode("not a container"),
      containerMimeType: ASIC_E_FILE_FORMAT.mimeType,
      containerName: "filing.asice",
      zipNameCodePage: "ibm437",
      part: { kind: FILE_PART_KINDS.member, index: 0 },
    });
    expect(result.isErr() && result.error._tag).toBe("AsicParseError");
  });

  test("a part declared as a generic ZIP is the format its name names", () => {
    const of = (fileName: string) =>
      containerOf({
        bytes: new Uint8Array(),
        mimeType: "application/zip",
        fileName,
      })?.format;
    expect(of("leping.asice")).toBe("asicE");
    expect(of("FV-2026-0042.isdocx")).toBe("isdocx");
    expect(of("podklady.zip")).toBe("zip");
    expect(of("smlouva.docx")).toBeUndefined();
  });

  test("the reply carries any name and any bytes through unchanged", () => {
    const bytes = new Uint8Array([0x0a, 0, 0xff, 0x0a]);
    const part = {
      fileName: "řádek\nnový.bin",
      mimeType: "application/octet-stream",
      bytes,
    };
    const decoded = decodeEmbeddedPart(encodeEmbeddedPart(part));
    expect(decoded?.fileName).toBe(part.fileName);
    expect(Array.from(decoded?.bytes ?? [])).toEqual(Array.from(bytes));
    expect(decodeEmbeddedPart(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
