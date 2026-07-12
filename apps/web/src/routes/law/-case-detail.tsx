import { lazy, Suspense, useState } from "react";

import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { createCaseLawDecisionPath } from "@/lib/case-law-route";
import {
  extractId,
  type PublicCaseLawDecision,
  type PublicDecisionRouteParams,
} from "@/routes/law/-case-detail.logic";

const AuthenticatedCaseLawWorkspace = lazy(async () => {
  const module = await import("@/components/authenticated-case-law-workspace");
  return {
    default: module.AuthenticatedCaseLawWorkspace,
  };
});

const SignInDialog = lazy(async () => {
  const module = await import("@/components/auth/sign-in-dialog");
  return { default: module.SignInDialog };
});

type PublicDecisionViewerProps = {
  decision: PublicCaseLawDecision;
  initialSearchQuery?: string | undefined;
  params: PublicDecisionRouteParams;
};

export function PublicDecisionViewer({
  decision,
  initialSearchQuery,
  params,
}: PublicDecisionViewerProps) {
  const decisionId = extractId(decision.id);
  const authStatus = useClientAuthStatus();
  const [authRedirectTo, setAuthRedirectTo] = useState<string | null>(null);
  const requestAuth = (redirectTo: string) => {
    setAuthRedirectTo(redirectTo);
  };
  const publicPath = createCaseLawDecisionPath(params);

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
                publicPath={publicPath}
                requestAuth={requestAuth}
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
            publicPath={publicPath}
            requestAuth={requestAuth}
          />
        </div>
      )}
      {authRedirectTo !== null && (
        <Suspense fallback={null}>
          <SignInDialog
            onOpenChange={(open) => {
              if (!open) {
                setAuthRedirectTo(null);
              }
            }}
            open
            redirectTo={authRedirectTo}
          />
        </Suspense>
      )}
    </main>
  );
}
