import { CITATION_POLARITY_EVIDENCE_CONSTRAINT_VALIDATIONS } from "../citation-polarity-evidence-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";
import { POLARITY_RULE_KIND_REPAIR } from "../polarity-rule-kind-repair";

// The seed kinds land before the rule checks validate.
export default {
  id: "repairs-citation-polarity-evidence",
  revision: 1437,
  type: "repairs",
  values: [
    POLARITY_RULE_KIND_REPAIR,
    ...CITATION_POLARITY_EVIDENCE_CONSTRAINT_VALIDATIONS,
  ],
} satisfies OnlineMigrationEntry;
