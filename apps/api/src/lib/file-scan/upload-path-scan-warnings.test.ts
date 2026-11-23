/**
 * An archive with content the scan could not read is accepted only with its
 * warning (`unscanned-content.test.ts`), so every path that stores an upload
 * must keep the scan's warnings beside the file it writes. A path that drops
 * them stores a password-protected archive that looks fully scanned.
 */
import { describe, expect, test } from "bun:test";

const API_SRC = new URL("../../", import.meta.url);

const UPLOAD_PATHS = [
  {
    path: "handlers/uploads/update.ts",
    surface: "matter uploads from the web, mobile, MCP and the CLI",
    reads: "const scanWarnings = scanned.scanWarnings ?? undefined;",
    writes: "    scanWarnings,\n",
  },
  {
    path: "handlers/entities/upload.ts",
    surface: "direct matter uploads",
    reads: "const scanWarnings = scanned.scanWarnings ?? undefined;",
    writes: "...(scanWarnings !== undefined && { scanWarnings })",
  },
  {
    path: "handlers/entities/versions/upload.ts",
    surface: "new versions",
    reads: "scanWarnings: scanned.value.scanWarnings ?? undefined,",
    writes: "scanWarnings: scanned.value.scanWarnings ?? undefined,",
  },
  {
    path: "handlers/chat/upload-files.ts",
    surface: "chat attachments",
    reads: "const scanWarnings = scanned.scanWarnings;",
    writes: "        scanWarnings,\n",
  },
  {
    path: "lib/email/inbound/persistence.ts",
    surface: "email and data-box filing",
    reads: "scanWarnings: file.scanWarnings ?? undefined,",
    writes: "scanWarnings: file.scanWarnings ?? undefined,",
  },
  {
    path: "handlers/files/part-save-scan.ts",
    surface: "file parts saved to a matter",
    reads: "scanWarnings: scanResult.value.scanWarnings ?? undefined,",
    writes: "scanWarnings: scanResult.value.scanWarnings ?? undefined,",
  },
  {
    path: "handlers/files/part-save.ts",
    surface: "file parts saved to a matter",
    reads: "const { scanned, scanWarnings } = yield* Result.await(",
    writes: "        scanWarnings,\n",
  },
  {
    path: "handlers/sharepoint/import-file.ts",
    surface: "SharePoint imports",
    reads: "scanWarnings: scanned.scanWarnings ?? undefined,",
    writes: "scanWarnings: scanned.scanWarnings ?? undefined,",
  },
] as const;

describe("every upload path keeps the scan's warnings with the stored file", () => {
  test.each(UPLOAD_PATHS)(
    "$surface ($path)",
    async ({ path, reads, writes }) => {
      const source = await Bun.file(new URL(path, API_SRC)).text();

      expect(source).toContain(reads);
      expect(source).toContain(writes);
    },
  );
});
