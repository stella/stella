import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { mainLegalDocument } from "@/components/ai-suggestions/main-legal-document.logic";
import { useMainCaseLawDecision } from "@/features/case-law/use-main-decision";
import { useMainStatute } from "@/features/statutes/use-main-statute";

/**
 * The legal document on screen, for the surfaces that bind a chat to it. Both
 * reads are route matches, so this returns `undefined` on every route that
 * shows no corpus document, the whole matter workspace included.
 */
export const useMainLegalDocument = (): ActiveLegalDocument | undefined => {
  const decision = useMainCaseLawDecision();
  const statute = useMainStatute();
  return mainLegalDocument({ decision, statute });
};
