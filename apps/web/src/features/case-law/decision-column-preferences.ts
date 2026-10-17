import * as v from "valibot";

import { usePublicLawTableLayout } from "@/components/public-law-table/use-public-law-table-layout";
import type { PublicLawTableLayoutStore } from "@/components/public-law-table/use-public-law-table-layout";
import { DEFAULT_DECISION_TABLE_LAYOUT } from "@/features/case-law/decision-column-preferences.logic";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import {
  definePersistedState,
  keepInAnyScope,
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

const layoutEntry = definePersistedState({
  key: "case_law_hidden_columns",
  area: "local",
  version: 1,
  schema: v.custom<Record<string, DecisionTableLayout>>(() => true),
  maxBytes: 131_072,
  defaultValue: () => ({}),
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

const DECISION_LAYOUT_STORE: PublicLawTableLayoutStore<DecisionTableLayout> = {
  read: () => readPersistedState(layoutEntry, {}),
  write: (layouts) => {
    writePersistedState(layoutEntry, {}, layouts);
  },
  defaultLayout: DEFAULT_DECISION_TABLE_LAYOUT,
};

/** How this browser draws the decision table in a jurisdiction, and how to change it. */
export const useDecisionColumnPreferences = (country: string) =>
  usePublicLawTableLayout(DECISION_LAYOUT_STORE, country);
