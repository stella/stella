import { lazy, Suspense } from "react";

import { useNavigate } from "@tanstack/react-router";
import { Minimize2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import Tooltip from "@/components/tooltip";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import {
  extractId,
  type PublicCaseLawDecision,
} from "@/routes/law/-case-detail.logic";

const AuthenticatedCaseLawWorkspace = lazy(async () => {
  const module = await import("@/components/authenticated-case-law-workspace");
  return {
    default: module.AuthenticatedCaseLawWorkspace,
  };
});

type PublicDecisionViewerProps = {
  decision: PublicCaseLawDecision;
  initialSearchQuery?: string | undefined;
};

export function PublicDecisionViewer({
  decision,
  initialSearchQuery,
}: PublicDecisionViewerProps) {
  const decisionId = extractId(decision.id);
  const authStatus = useClientAuthStatus();
  const inspector = useInspectorView();
  const navigate = useNavigate();
  const t = useTranslations();

  const moveToSide = () => {
    inspector.open(
      createCaseDecisionViewTab({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
      }),
    );
    detached(
      navigate({
        to: "/law/cases",
        search: { country: decision.country.toLowerCase() },
      }),
      "case-law.move-to-side",
    );
  };

  return (
    <main className="flex min-h-0 flex-1 overflow-hidden">
      <ChromeHeaderActions>
        <Tooltip
          content={t("chat.moveToSide")}
          render={
            <Button
              aria-label={t("chat.moveToSide")}
              className="hidden md:inline-flex"
              onClick={moveToSide}
              size="icon-sm"
              variant="ghost"
            >
              <Minimize2Icon className="size-4" />
            </Button>
          }
        />
      </ChromeHeaderActions>
      {authStatus.isAuthenticated ? (
        <Suspense
          fallback={
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <DecisionWorkspace
                aiMode="locked"
                decision={decision}
                decisionId={decisionId}
                initialSearchQuery={initialSearchQuery}
              />
            </div>
          }
        >
          <AuthenticatedCaseLawWorkspace
            decision={decision}
            decisionId={decisionId}
            initialSearchQuery={initialSearchQuery}
            user={authStatus.user}
          />
        </Suspense>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <DecisionWorkspace
            aiMode="locked"
            decision={decision}
            decisionId={decisionId}
            initialSearchQuery={initialSearchQuery}
          />
        </div>
      )}
    </main>
  );
}
