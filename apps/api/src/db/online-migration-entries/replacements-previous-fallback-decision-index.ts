import { PREVIOUS_FALLBACK_DECISION_INDEX } from "../../lib/case-law/fallback-decision-identity-constants";
import type { OnlineMigrationEntry } from "../online-migration-entry";
import { FALLBACK_DECISION_UNIQUE_INDEXES } from "../online-unique-indexes";

export default {
  id: "replacements-previous-fallback-decision-index",
  revision: 1458,
  type: "replacements",
  values: [
    {
      introducedBy: "20261114200100_case_law_fallback_contract",
      // The docket-only index retires once both court/evidence and content
      // replacements validate.
      legacyName: PREVIOUS_FALLBACK_DECISION_INDEX,
      replacementNames: FALLBACK_DECISION_UNIQUE_INDEXES.map(
        ({ name }) => name,
      ),
    },
  ],
} satisfies OnlineMigrationEntry;
