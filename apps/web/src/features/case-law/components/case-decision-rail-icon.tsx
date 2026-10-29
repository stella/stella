import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import type { InspectorRailIconProps } from "@/components/inspector/view-registry";

/**
 * The case number stands for the tab, the way a statute tab shows `165/12`:
 * a reader with three decisions of one court open tells them apart by number,
 * which a court chip they all share cannot do. The number travels in the tab
 * itself, so the label is there before the decision is read.
 */
export const CaseDecisionRailIcon = ({
  tab,
}: InspectorRailIconProps<CaseDecisionViewPayload>) => (
  <DocumentIdentityBadge
    identity={{ kind: "caseNumber", caseNumber: tab.payload.caseNumber }}
  />
);
