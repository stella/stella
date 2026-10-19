import { maybeEmitDocumentReviewSignal as recordSource } from "@/api/lib/scouts/document-review";
import type { EmitDocumentReviewSignalArgs } from "@/api/lib/scouts/document-review";

export const maybeEmitDocumentReviewSignal = async (
  args: EmitDocumentReviewSignalArgs,
): Promise<void> => {
  await recordSource(args);
};
