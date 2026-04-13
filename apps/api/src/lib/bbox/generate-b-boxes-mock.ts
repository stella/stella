import { panic } from "better-result";
import { sleep } from "bun";

import { parseGeminiBBoxes } from "@/api/lib/bbox/generate-b-boxes-shared";
import type {
  GenerateBBoxesProps,
  GenerateBBoxesResult,
} from "@/api/lib/bbox/generate-b-boxes-shared";

export const generateBBoxesMock = async ({
  data: { pdf, pageNumber },
}: GenerateBBoxesProps): Promise<GenerateBBoxesResult> => {
  await sleep(3000);

  const page = pdf.getPage(pageNumber - 1);

  if (!page) {
    panic(`Page ${pageNumber} not found`);
  }

  return parseGeminiBBoxes([[100, 100, 300, 900]], {
    pageNumber,
    width: page.width,
    height: page.height,
  });
};
