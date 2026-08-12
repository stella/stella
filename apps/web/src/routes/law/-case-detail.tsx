import { lazy, Suspense } from "react";

import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
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

  return (
    <main className="flex min-h-0 flex-1 overflow-hidden">
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
