import type { FolioAIEditSkipReason } from "@stll/folio-core/ai-edits";

export const FOLIO_AI_EDIT_SKIP_REASONS = [
  "missingBlock",
  "changedBlock",
  "ambiguousFind",
  "missingFind",
  "unsupportedBlock",
  "unsupportedMode",
  "atomicBatchRejected",
  "preconditionFailed",
  "staleRange",
  "emptyOperation",
  "noopOperation",
  "documentVersionMismatch",
  "documentNotEditable",
] as const satisfies readonly FolioAIEditSkipReason[];

type MissingFolioAIEditSkipReason = Exclude<
  FolioAIEditSkipReason,
  (typeof FOLIO_AI_EDIT_SKIP_REASONS)[number]
>;

true satisfies MissingFolioAIEditSkipReason extends never ? true : never;
