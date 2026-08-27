import { DECIDED_AGENT_SKILL_PROPOSAL_STATUSES } from "@/api/db/schema";
import type { AgentSkillProposalStatus } from "@/api/db/schema";
import { includes } from "@/api/lib/type-guards";

/** A decided proposal is final: it can no longer be edited or re-decided. */
export const isDecidedProposalStatus = (
  status: AgentSkillProposalStatus,
): boolean => includes(DECIDED_AGENT_SKILL_PROPOSAL_STATUSES, status);
