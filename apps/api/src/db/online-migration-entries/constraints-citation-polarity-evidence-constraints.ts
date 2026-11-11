import { CITATION_POLARITY_EVIDENCE_CONSTRAINTS } from "../citation-polarity-evidence-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-citation-polarity-evidence-constraints",
  revision: 1436,
  type: "constraints",
  values: [...CITATION_POLARITY_EVIDENCE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
