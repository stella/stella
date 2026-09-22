import { usePublicLawTableLayout } from "@/components/public-law-table/use-public-law-table-layout";
import type { PublicLawTableLayoutStore } from "@/components/public-law-table/use-public-law-table-layout";
import {
  DEFAULT_DECISION_TABLE_LAYOUT,
  decisionTableLayouts,
  StoredDecisionLayoutSchema,
} from "@/features/case-law/decision-column-preferences.logic";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import { readStoredJson } from "@/lib/stored-json";

const DECISION_LAYOUT_STORE: PublicLawTableLayoutStore<DecisionTableLayout> = {
  storageKey: "case_law_hidden_columns",
  read: (raw) =>
    decisionTableLayouts(readStoredJson(raw, StoredDecisionLayoutSchema) ?? {}),
  defaultLayout: DEFAULT_DECISION_TABLE_LAYOUT,
};

/** How this browser draws the decision table in a jurisdiction, and how to change it. */
export const useDecisionColumnPreferences = (country: string) =>
  usePublicLawTableLayout(DECISION_LAYOUT_STORE, country);
