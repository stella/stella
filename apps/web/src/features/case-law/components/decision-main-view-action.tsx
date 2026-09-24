import type { MouseEvent } from "react";

import { Link } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import {
  createCaseDecisionViewTab,
  isPlainPrimaryClick,
} from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import Tooltip from "@/components/tooltip";
import { decisionMainViewAction } from "@/features/case-law/decision-main-view.logic";
import { useMainCaseLawDecision } from "@/features/case-law/use-main-decision";

type DecisionMainViewActionProps = {
  /** The decision the tab holds, carrying its route identity. */
  payload: CaseDecisionViewPayload;
  /**
   * Run just before the main view changes. The reader tab closes itself — the
   * text it holds is about to fill the page — while the facts tab stays, the
   * way a file tab stays when its document is maximized.
   */
  onMoveToMain?: (() => void) | undefined;
};

/**
 * Show the entire decision: the maximize a file tab carries, on a decision.
 *
 * Nothing is offered while the main view is already this decision — the whole
 * text is on screen behind the tab, and the page chrome carries the way back
 * to the side. When the main view holds another decision, that one docks here
 * as this one takes the page, so maximizing never loses a reader's place.
 */
export const DecisionMainViewAction = ({
  onMoveToMain,
  payload,
}: DecisionMainViewActionProps) => {
  const t = useTranslations();
  const inspector = useInspectorView();
  const mainDecision = useMainCaseLawDecision();
  const action = decisionMainViewAction({
    decisionId: payload.decisionId,
    mainDecision,
  });
  if (action.type === "already-main") {
    return null;
  }

  // Plain primary click moves this decision to main; modified clicks stay
  // native (new browser tab) and leave the inspector untouched.
  const onNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainPrimaryClick(event)) {
      return;
    }
    onMoveToMain?.();
    if (action.type === "swap-with-main") {
      const displaced = action.mainDecision;
      inspector.open(
        createCaseDecisionViewTab({
          caseNumber: displaced.caseNumber,
          country: displaced.country,
          court: displaced.court,
          decisionId: displaced.id,
          language: displaced.language,
          languageAlternates: displaced.languageAlternates,
          slug: displaced.slug,
        }),
      );
    }
  };

  const label =
    action.type === "swap-with-main"
      ? t("inspector.swapViews")
      : t("inspector.moveToMain");
  const { route } = payload;
  const link =
    route.language === undefined ? (
      <Link
        onClick={onNavigate}
        params={{
          country: route.country,
          court: route.court,
          slug: route.slug,
        }}
        to="/law/$country/cases/$court/$slug"
      />
    ) : (
      <Link
        onClick={onNavigate}
        params={{
          country: route.country,
          court: route.court,
          language: route.language,
          slug: route.slug,
        }}
        to="/law/$country/cases/$court/$language/$slug"
      />
    );

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          render={link}
          size="icon-xs"
          variant="ghost"
        />
      }
    >
      <Maximize2Icon className="size-3.5" />
    </Tooltip>
  );
};
