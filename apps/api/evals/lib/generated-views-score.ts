import { panic } from "better-result";
import * as v from "valibot";

import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import { generatedViewsCases } from "./generated-views-cases";

export const generatedViewsLocalResultSchema = v.object({
  caseId: v.string(),
  harness: v.pipe(v.string(), v.minLength(1)),
  answer: v.string(),
  toolCalls: v.array(v.object({ name: v.string() })),
});

export const scoreGeneratedViews = (
  results: v.InferOutput<typeof generatedViewsLocalResultSchema>[],
) => {
  const expectedIds = generatedViewsCases.map(({ id }) => id).toSorted();
  const actualIds = results.map(({ caseId }) => caseId).toSorted();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    panic("Results must cover each generated-view case exactly once");
  }
  return results.map(({ caseId, toolCalls, answer }) => ({
    caseId,
    selectionPass: toolCalls.some(
      ({ name }) => name === VISUAL_PREVIEW_TOOL_NAME,
    ),
    presentationPass: !/```\s*html\b/iu.test(answer),
  }));
};
