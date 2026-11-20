import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { STRUCTURED_DOCUMENT_FORMATS } from "@stll/api-contract/structured-document-formats";
import { ZipArchive } from "@stll/docx-core/zip";

import { readStructuredDocumentPreview } from "@/api/lib/files/archive-preview";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const documents = {
  uyap: async () => {
    const zip = new ZipArchive();
    zip.set(
      "content.xml",
      '<template format_id="1.8"><content>örnek</content><elements><paragraph><content startOffset="0" length="5"/></paragraph></elements></template>',
    );
    return { bytes: await zip.generate(), text: "örnek" };
  },
  ofd: async () => ({
    bytes: await readFile(
      new URL("fixtures/ofdrw/helloworld.ofd", import.meta.url),
    ),
    text: "你好呀，OFD Reader&Writer！",
  }),
};

test.each(STRUCTURED_DOCUMENT_FORMATS)(
  "opens a legacy generic $label upload and gives search the same text as Files",
  async ({ kind, mimeType, extensions }) => {
    const { bytes, text } = await documents[kind]();
    const file = testScannedFile({
      bytes: new Uint8Array(bytes).buffer,
      path: `org/matter/filing${extensions[0]}`,
      mimeType: "application/zip",
    });
    const preview = await readStructuredDocumentPreview(
      file.withMimeType(mimeType),
    );
    expect(preview.unwrap()).toEqual({ text, truncated: false });
    expect((await extractFileTextResult(file)).unwrap()).toEqual(text);
  },
);

test.each(STRUCTURED_DOCUMENT_FORMATS)(
  "shows preview unavailable for an unreadable $label and preserves extraction failure",
  async ({ mimeType, extensions }) => {
    const file = testScannedFile({
      bytes: new TextEncoder().encode("ordinary file").buffer,
      path: `org/matter/upload${extensions[0]}`,
      mimeType,
    });
    const preview = await readStructuredDocumentPreview(file);
    expect(preview.isErr() && preview.error).toMatchObject({
      status: 422,
      code: "preview_unavailable",
    });
    expect((await extractFileTextResult(file)).isErr()).toBe(true);
  },
);
