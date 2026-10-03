import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectOfficeFixture,
  listOfficeFixtures,
  OfficeFixtureMetadataError,
} from "./check-office-fixture-metadata";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const fixture = async (parts: Record<string, string>) => {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(parts)) {
    zip.file(name, bytes);
  }
  return await zip.generateAsync({ type: "uint8array" });
};
const inspect = async (parts: Record<string, string>) =>
  await inspectOfficeFixture({
    filePath: "fixture.docx",
    bytes: await fixture(parts),
  });
const core = (contents: string) =>
  `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${contents}</cp:coreProperties>`;
const fields = (result: Awaited<ReturnType<typeof inspect>>) => {
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value.map(({ field }) => field);
};

describe("office fixture metadata", () => {
  test("admits neutral properties and ignores document content", async () => {
    expect(
      fields(
        await inspect({
          "docProps/core.xml": core(
            "<dc:creator>stella</dc:creator><cp:lastModifiedBy/>",
          ),
          "docProps/app.xml":
            "<Properties><Company/><Manager>stella</Manager></Properties>",
          "word/document.xml": "<document>Example Person</document>",
        }),
      ),
    ).toEqual([]);
  });

  test.each(["creator", "title", "subject", "description"])(
    "checks core %s independently of its namespace prefix",
    async (field) => {
      expect(
        fields(
          await inspect({
            "docProps/core.xml": core(
              `<dc:${field}>Example Person</dc:${field}>`,
            ),
          }),
        ),
      ).toEqual([`docProps/core.xml:${field}`]);
    },
  );

  test.each(["lastModifiedBy", "keywords", "Company", "Manager", "Template"])(
    "checks %s",
    async (field) => {
      expect(
        fields(
          await inspect({
            "docProps/app.xml": `<Properties><${field}>Example Person</${field}></Properties>`,
          }),
        ),
      ).toEqual([`docProps/app.xml:${field}`]);
    },
  );

  test("reads escaped and nested text without logging its contents", async () => {
    const result = await inspect({
      "docProps/core.xml": core("<dc:creator>Example &#80;erson</dc:creator>"),
    });
    expect(fields(result)).toEqual(["docProps/core.xml:creator"]);
    expect(JSON.stringify(result)).not.toContain("Example");
  });

  test("requires exact allowlist tokens", async () => {
    expect(
      fields(
        await inspect({
          "docProps/core.xml": core("<dc:creator>stella Example</dc:creator>"),
        }),
      ),
    ).toHaveLength(1);
  });

  test("checks ODF properties and template attributes", async () => {
    const result = await inspect({
      "meta.xml":
        '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><office:meta><meta:initial-creator>Example Person</meta:initial-creator><meta:template xlink:href="example-template"/></office:meta></office:document-meta>',
    });
    expect(fields(result)).toEqual([
      "meta.xml:initial-creator",
      "meta.xml:template@href",
    ]);
  });

  test("fails closed on ODF encryption", async () => {
    const result = await inspect({
      "META-INF/manifest.xml":
        '<manifest xmlns:m="urn:odf"><m:encryption-data/></manifest>',
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("encrypted");
    }
  });

  test.each([
    "<broken>",
    '<!DOCTYPE root [<!ENTITY name "Example Person">]><root>&name;</root>',
  ])("returns a typed, content-free XML failure", async (xml) => {
    const result = await inspect({ "docProps/core.xml": xml });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(OfficeFixtureMetadataError);
      expect(result.error.reason).toBe("invalid-xml");
      expect(JSON.stringify(result.error)).not.toContain("Example");
    }
  });

  test("returns a typed failure for a corrupt or encrypted container", async () => {
    const result = await inspectOfficeFixture({
      filePath: "fixture.docx",
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(OfficeFixtureMetadataError);
      expect(result.error.field).toBe("archive");
    }
  });
  test("returns a typed failure for an encrypted ZIP entry", async () => {
    const bytes = await fixture({
      "docProps/core.xml": core("<dc:creator>stella</dc:creator>"),
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = Buffer.from(bytes).indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    expect(offset).toBeGreaterThan(0);
    const flags = view.getUint16(offset + 8, true);
    expect(flags % 2).toBe(0);
    view.setUint16(offset + 8, flags + 1, true);
    const result = await inspectOfficeFixture({
      filePath: "fixture.docx",
      bytes,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.field).toBe("archive");
    }
  });

  test("detects a CRC mismatch before inspecting metadata", async () => {
    const bytes = await fixture({
      "docProps/core.xml": core("<dc:creator>stella</dc:creator>"),
    });
    const offset = Buffer.from(bytes).indexOf("stella");
    expect(offset).toBeGreaterThan(0);
    bytes.set(new TextEncoder().encode("X"), offset);
    const result = await inspectOfficeFixture({
      filePath: "fixture.docx",
      bytes,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.field).toBe("archive");
    }
  });

  test("enumerates every tracked office extension and excludes untracked files", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "office-fixtures-"));
    temporaryDirectories.push(rootDir);
    const runGit = (args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: rootDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    };
    runGit(["init", "--quiet"]);
    const files = [
      "a.docx",
      "b.xlsx",
      "c.pptx",
      "d.odt",
      "e.ods",
      "f.odp",
      "g.dotx",
      "h.DOCX",
    ];
    for (const file of [...files, "ignored.txt", "untracked.docx"]) {
      await Bun.write(path.join(rootDir, file), "fixture");
    }
    runGit(["add", "--", ...files, "ignored.txt"]);
    const result = listOfficeFixtures(rootDir);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.toSorted()).toEqual(files.toSorted());
  });
});
