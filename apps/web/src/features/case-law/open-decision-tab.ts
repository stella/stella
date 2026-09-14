/**
 * The one action that opens a public decision beside the results.
 *
 * Every gesture that opens a decision from a results row goes through it: the
 * row itself, the case-number link, the matched passage, a question's source
 * chip. Kept apart from the row host so a cell can open a decision without
 * pulling the table's row — and the grid behind it — into its bundle.
 *
 * Beside the results is only possible where there is a beside: the public
 * inspector dock is not rendered below `md` (see `PublicInspectorDock`), so on
 * a phone opening a tab would change nothing on screen. There the gesture goes
 * to the decision's own page instead, by the same navigation the row uses: the
 * link's href is the page without the search that found it, and a reader who
 * tapped a result asked for the passage and the words, not the bare page.
 */

import type { MouseEvent } from "react";

import { useNavigate } from "@tanstack/react-router";

import { useIsMobile } from "@stll/ui/use-mobile";

import {
  createCaseDecisionViewTab,
  isPlainPrimaryClick,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { DecisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import { detached } from "@/lib/detached";

export const useOpenDecisionTab = () => {
  const openView = useInspectorTabsStore((s) => s.openView);
  const navigate = useNavigate();
  const inspectorAvailable = !useIsMobile();

  const open = (target: DecisionTabTarget) => {
    const tab = createCaseDecisionViewTab(target);
    if (inspectorAvailable) {
      openView(tab);
      return;
    }
    detached(
      navigateToCaseDecisionMain(navigate, tab.payload),
      "case-law.open-decision-page",
    );
  };

  return {
    /** The row's own gesture: a click or Enter, with no href to fall back to. */
    open,
    /**
     * A decision link's click, which opens exactly what the row's own gesture
     * opens. Every browser navigation gesture (middle click, ⌘/Ctrl click,
     * "open in new tab") is left alone and follows the href to the full page,
     * so the URL a reader copies or shares is the decision, not a search.
     */
    onLinkClick:
      (target: DecisionTabTarget) => (event: MouseEvent<HTMLAnchorElement>) => {
        if (!isPlainPrimaryClick(event)) {
          return;
        }
        event.preventDefault();
        open(target);
      },
  };
};
