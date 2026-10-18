import {
  publicLawTableLayoutStore,
  usePublicLawTableLayout,
} from "@/components/public-law-table/use-public-law-table-layout";
import { DEFAULT_DECISION_TABLE_LAYOUT } from "@/features/case-law/decision-column-preferences.logic";

const DECISION_LAYOUT_STORE = publicLawTableLayoutStore(
  "decisionLayouts",
  DEFAULT_DECISION_TABLE_LAYOUT,
);

/** How this browser draws the decision table in a jurisdiction, and how to change it. */
export const useDecisionColumnPreferences = (country: string) =>
  usePublicLawTableLayout(DECISION_LAYOUT_STORE, country);
