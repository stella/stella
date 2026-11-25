import type { JustificationContent } from "@/api/db/schema";
import type { CaseLawQuestionContent } from "@/api/db/schema-validators";

/**
 * What a question column asks for, and what a cell holds.
 *
 * A question column is a matter property asked of a decision: it carries the
 * same content the property does (kind, select options, fallback), its answer
 * is the same `FieldContent` a workspace field holds, and its provenance is the
 * same justification shape — so one cell renderer and one output registry serve
 * both surfaces.
 */
export type CaseLawResearchColumnContent = CaseLawQuestionContent;

export type CaseLawResearchAnswerRun = {
  version: 1;
  model: string;
  completedAt: string;
  /** True when the decision was too long to send whole and passages were retrieved. */
  retrieved: boolean;
  rationale: string;
  /** The cited passages, in the citation shape a workspace justification uses. */
  justification: JustificationContent;
};
