import { panic, Result } from "better-result";

import { generateBBoxData } from "@/api/handlers/registry/actors/b-box/ai-generate-b-boxes";
import { parseGeminiBBoxes } from "@/api/handlers/registry/actors/b-box/generate-b-boxes-shared";
import type {
  GenerateBBoxesProps,
  GenerateBBoxesResult,
} from "@/api/handlers/registry/actors/b-box/generate-b-boxes-shared";

export const generateBBoxes = async ({
  abortSignal,
  justificationId,
  organizationId,
  orgAIConfig,
  workspaceId,
  data: { prompt, fieldContent, justificationText, pdf, pageNumber },
}: GenerateBBoxesProps): Promise<GenerateBBoxesResult> => {
  const pagePdf = await pdf.extractPages([pageNumber - 1]);
  const page = pagePdf.getPage(0);
  const pdfData = await pagePdf.save();

  if (!page) {
    panic(`Page ${pageNumber} doesn't exist in the PDF`);
  }

  const { height, width } = page;

  const result = Result.unwrap(
    await generateBBoxData({
      pdfData,
      prompt,
      fieldContent,
      justificationText,
      abortSignal,
      justificationId,
      organizationId,
      orgAIConfig: orgAIConfig ?? null,
      pageNumber,
      workspaceId,
    }),
  );

  return parseGeminiBBoxes(result, {
    pageNumber,
    width,
    height,
  });
};
