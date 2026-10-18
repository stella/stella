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

const FENCED_BLOCK = /```([^\n]*)\n([\s\S]*?)(?:```|$)/gu;
const HTML_DOCUMENT_TAG =
  /<(?:!doctype\s+html|html|head|body|div|section|article|table|svg|style|script|h[1-6]|p|ul|ol)\b/iu;

/** True when the answer pastes HTML in a code fence, labelled or not. */
const hasFencedHtml = (answer: string) =>
  [...answer.matchAll(FENCED_BLOCK)].some(
    ([, label = "", body = ""]) =>
      /^\s*html\b/iu.test(label) || HTML_DOCUMENT_TAG.test(body),
  );

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
    presentationPass: !hasFencedHtml(answer),
  }));
};
