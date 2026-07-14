import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
  extractDocumentStyleSetFromDocx,
} from "@stll/folio-core/server";

type CreateTemplateBufferOptions =
  | { type: "stella" }
  | { type: "style-source"; buffer: Buffer; name: string };

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
    new Uint8Array(await createDocx(createEmptyDocument({ preset }))),
  );
};
