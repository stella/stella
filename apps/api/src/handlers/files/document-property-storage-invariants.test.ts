import { describe, expect, test } from "bun:test";

const STORAGE_READ_HANDLERS = [
  "document-properties.ts",
  "scrubbed-download.ts",
  "update-document-properties.ts",
] as const;

const readHandlerSource = async (fileName: string) =>
  await Bun.file(new URL(fileName, import.meta.url)).text();

describe("document property storage boundaries", () => {
  test("every bounded S3 read forwards its timeout signal", async () => {
    const handlers = await Promise.all(
      STORAGE_READ_HANDLERS.map(async (fileName) => ({
        fileName,
        source: await readHandlerSource(fileName),
      })),
    );

    for (const { fileName, source } of handlers) {
      expect(source, fileName).toContain("async (signal) =>");
      expect(source, fileName).toMatch(
        /readS3ArrayBuffer\([\s\S]*?\n\s+signal,\n\s+\),/u,
      );
    }
  });

  test("metadata-only versions retain the source file's scan warnings", async () => {
    const source = await readHandlerSource("update-document-properties.ts");

    expect(source).toContain("scanWarnings: content.scanWarnings,");
    expect(source).toContain('type: "replace-current-file-from-version"');
    expect(source).toContain("expectedCurrentVersionId: row.entityVersionId");
  });
});
