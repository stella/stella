import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectOfficeFixture,
  listOfficeFixtures,
  OFFICE_FIXTURE_EXTENSIONS,
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

const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SPREADSHEET_NAMESPACE =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const wordPart = (contents: string) =>
  `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${contents}</w:body></w:document>`;

const identityCases = [
  ...["ins", "del", "moveFrom", "moveTo"].map((element) => ({
    label: `Word ${element} author`,
    part: "word/document.xml",
    xml: (identity: string) =>
      wordPart(
        `<w:${element} w:id="1" w:author="${identity}"><w:r><w:t>Body text</w:t></w:r></w:${element}>`,
      ),
  })),
  ...["author", "initials"].map((attribute) => ({
    label: `Word comment ${attribute}`,
    part: "word/comments.xml",
    xml: (identity: string) =>
      `<w:comments xmlns:w="${WORD_NAMESPACE}"><w:comment w:id="1" w:${attribute}="${identity}"><w:p/></w:comment></w:comments>`,
  })),
  ...[
    { part: "header1", element: "hdr" },
    { part: "footer1", element: "ftr" },
  ].map(({ part, element }) => ({
    label: `Word ${part} tracked author`,
    part: `word/${part}.xml`,
    xml: (identity: string) =>
      `<w:${element} xmlns:w="${WORD_NAMESPACE}"><w:p><w:ins w:id="1" w:author="${identity}"><w:r><w:t>Body text</w:t></w:r></w:ins></w:p></w:${element}>`,
  })),
  ...["author", "userId", "providerId"].map((attribute) => ({
    label: `Word people ${attribute}`,
    part: "word/people.xml",
    xml: (identity: string) =>
      `<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="${attribute === "author" ? identity : "stella"}"><w15:presenceInfo w15:${attribute === "author" ? "userId" : attribute}="${attribute === "author" ? "stella" : identity}"/></w15:person></w15:people>`,
  })),
  {
    label: "custom document property value",
    part: "docProps/custom.xml",
    xml: (identity: string) =>
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="stella"><vt:lpwstr>${identity}</vt:lpwstr></property></Properties>`,
  },
  {
    label: "custom document property name",
    part: "docProps/custom.xml",
    xml: (identity: string) =>
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${identity}"><vt:lpwstr>stella</vt:lpwstr></property></Properties>`,
  },
  {
    label: "spreadsheet legacy comment author",
    part: "xl/comments1.xml",
    xml: (identity: string) =>
      `<comments xmlns="${SPREADSHEET_NAMESPACE}"><authors><author>${identity}</author></authors><commentList><comment ref="A1" authorId="0"><text><t>Body text</t></text></comment></commentList></comments>`,
  },
  {
    label: "spreadsheet threaded mention display name",
    part: "xl/threadedComments/threadedComment1.xml",
    xml: (identity: string) =>
      `<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" personId="{11111111-1111-4111-8111-111111111111}" id="{22222222-2222-4222-8222-222222222222}"><text>Body text</text><mentions><mention personId="{11111111-1111-4111-8111-111111111111}" displayName="${identity}" startIndex="0" length="1"/></mentions></threadedComment></ThreadedComments>`,
  },
  ...["displayName", "userId", "providerId"].map((attribute) => ({
    label: `spreadsheet person ${attribute}`,
    part: "xl/persons/person.xml",
    xml: (identity: string) =>
      `<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person id="{11111111-1111-4111-8111-111111111111}" ${attribute}="${identity}"/></personList>`,
  })),
  ...["name", "initials"].map((attribute) => ({
    label: `presentation legacy author ${attribute}`,
    part: "ppt/commentAuthors.xml",
    xml: (identity: string) =>
      `<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cmAuthor id="0" ${attribute}="${identity}" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`,
  })),
  ...["name", "userId", "providerId"].map((attribute) => ({
    label: `presentation modern author ${attribute}`,
    part: "ppt/authors.xml",
    xml: (identity: string) =>
      `<p188:authorLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"><p188:author id="{11111111-1111-4111-8111-111111111111}" ${attribute}="${identity}"/></p188:authorLst>`,
  })),
  {
    label: "ODF annotation creator in content",
    part: "content.xml",
    xml: (identity: string) =>
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:body><office:annotation><dc:creator>${identity}</dc:creator></office:annotation></office:body></office:document-content>`,
  },
];

describe("office fixture metadata", () => {
  test.each(identityCases)(
    "rejects generated identity metadata in $label and admits a neutral identity",
    async ({ part, xml }) => {
      const identity = `Generated-${Bun.randomUUIDv7()}@example.test`;
      const rejected = await inspect({ [part]: xml(identity) });
      expect(fields(rejected).length).toBeGreaterThan(0);
      expect(JSON.stringify(rejected)).not.toContain(identity);
      expect(fields(await inspect({ [part]: xml("stella") }))).toEqual([]);
    },
  );

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
    const files = OFFICE_FIXTURE_EXTENSIONS.flatMap((extension, index) => [
      `fixture-${index}${extension}`,
      `uppercase-${index}${extension.toUpperCase()}`,
    ]);
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
