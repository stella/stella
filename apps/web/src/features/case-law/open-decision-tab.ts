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
 * to the decision's own page instead — a link by following its href, the row
 * by navigating to the same route.
 */

import type { MouseEvent } from "react";

import { useNavigate } from "@tanstack/react-router";

import { useIsMobile } from "@stll/ui/use-mobile";

import {
  createCaseDecisionViewTab,
  navigateToCaseDecisionMain,
  opensCitationInInspector,
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
     * A decision link's click. A plain left click opens the decision beside
     * the results, at the passage when the link names one; every browser
     * navigation gesture (middle click, ⌘/Ctrl click, "open in new tab") and
     * every tap where there is no dock is left alone and follows the href to
     * the full page, which the inspector also offers explicitly.
     */
    onLinkClick:
      (target: DecisionTabTarget) => (event: MouseEvent<HTMLAnchorElement>) => {
        if (!opensCitationInInspector(event, inspectorAvailable)) {
          return;
        }
        event.preventDefault();
        openView(createCaseDecisionViewTab(target));
      },
  };
};
