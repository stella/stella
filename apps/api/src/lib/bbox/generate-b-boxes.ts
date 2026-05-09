import { panic, Result } from "better-result";

import { generateBBoxData } from "@/api/lib/bbox/ai-generate-b-boxes";
import { parseGeminiBBoxes } from "@/api/lib/bbox/generate-b-boxes-shared";
import type {
  GenerateBBoxesProps,
  GenerateBBoxesResult,
} from "@/api/lib/bbox/generate-b-boxes-shared";

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

  const dataResult = await generateBBoxData({
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
  });

  if (Result.isError(dataResult)) {
    return Result.err(dataResult.error);
  }

  return Result.ok(
    parseGeminiBBoxes(dataResult.value, {
      pageNumber,
      width,
      height,
    }),
  );
};
