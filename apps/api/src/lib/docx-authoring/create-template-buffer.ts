import {
  createEmptyDocument,
  createStellaStyleDocumentPreset,
  extractDocumentStyleSetFromDocx,
} from "@stll/folio-core/server";

import { documentToDocx } from "@/api/lib/docx-authoring/document";

type CreateTemplateBufferOptions =
  | { type: "stella" }
  | { type: "style-source"; buffer: Buffer; name: string };

/** Builds a content-free DOCX from Stella Style or an extracted style source. */
export const createTemplateBuffer = async (
  options: CreateTemplateBufferOptions,
): Promise<Buffer> => {
  const preset = createStellaStyleDocumentPreset();
  if (options.type === "style-source") {
    preset.styleSet = await extractDocumentStyleSetFromDocx(options.buffer, {
      name: options.name,
    });
  }

  return Buffer.from(
    new Uint8Array(await documentToDocx(createEmptyDocument({ preset }))),
  );
};
