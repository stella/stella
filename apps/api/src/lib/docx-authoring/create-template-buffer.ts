import {
  createEmptyDocument,
  createStellaStyleDocumentPreset,
} from "@stll/folio-core/server";

import { documentToDocx } from "@/api/lib/docx-authoring/document";
import { extractScannedDocumentStyleSet } from "@/api/lib/file-scan/document-parsers";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";

type CreateTemplateBufferOptions =
  | { type: "stella" }
  | { type: "style-source"; file: ScannedFile; name: string };

/** Builds a content-free DOCX from Stella Style or an extracted style source. */
export const createTemplateBuffer = async (
  options: CreateTemplateBufferOptions,
): Promise<Buffer> => {
  const preset = createStellaStyleDocumentPreset();
  if (options.type === "style-source") {
    preset.styleSet = await extractScannedDocumentStyleSet(options.file, {
      name: options.name,
    });
  }

  return Buffer.from(
    new Uint8Array(await documentToDocx(createEmptyDocument({ preset }))),
  );
};
