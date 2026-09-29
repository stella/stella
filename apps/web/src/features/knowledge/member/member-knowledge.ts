import {
  memberPlaybooksActions,
  memberPlaybooksSource,
} from "@/features/knowledge/member/member-playbooks";
import {
  memberTemplatesActions,
  memberTemplatesSource,
} from "@/features/knowledge/member/member-templates";

/**
 * The organization's own Knowledge, for member routes only. A member route
 * reads through `memberKnowledgeSource` and writes through
 * `memberKnowledgeActions`, then hands the results to the shared views.
 */
export const memberKnowledgeSource = {
  ...memberTemplatesSource,
  ...memberPlaybooksSource,
};

export const memberKnowledgeActions = {
  ...memberTemplatesActions,
  ...memberPlaybooksActions,
};
