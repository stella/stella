import { createStore } from "zustand/vanilla";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";

type MainDecisionReader = {
  decisionId: string;
  openPassage: (payload: CaseDecisionViewPayload) => void;
};

/** The mounted main reader owns passage navigation; inspector readers never register. */
export const mainDecisionReaderStore = createStore<{
  reader: MainDecisionReader | null;
}>(() => ({ reader: null }));

export const registerMainDecisionReader = (reader: MainDecisionReader) => {
  mainDecisionReaderStore.setState({ reader });
  return () => {
    if (mainDecisionReaderStore.getState().reader === reader) {
      mainDecisionReaderStore.setState({ reader: null });
    }
  };
};
