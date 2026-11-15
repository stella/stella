import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  SHAREPOINT_OAUTH_CALLBACK_REASONS,
  type SharepointOAuthCallbackReason,
} from "@stll/api-contract/sharepoint";
import { Loader } from "@stll/ui/loader";
import { stellaToast } from "@stll/ui/toast";

import { sharepointKeys } from "@/features/sharepoint/sharepoint-queries";
import { useMountEffect } from "@/hooks/use-effect";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { notifyUserProblem } from "@/lib/errors/user-toast";
import { pageTitle } from "@/lib/page-title";
import { routeSearchSchema } from "@/route-search-params";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";

/** What the member reads when Microsoft consent did not end in a connection. */
const OAUTH_REASON_KEYS = {
  "not-enabled": "sharepoint.oauthReasons.notEnabled",
  "consent-denied": "sharepoint.oauthReasons.consentDenied",
  "missing-code": "sharepoint.oauthReasons.tryAgain",
  "expired-state": "sharepoint.oauthReasons.expired",
  "user-mismatch": "sharepoint.oauthReasons.userMismatch",
  "not-configured": "sharepoint.oauthReasons.notConfigured",
  "token-exchange": "sharepoint.oauthReasons.tryAgain",
  "invalid-secret": "sharepoint.oauthReasons.tryAgain",
  unexpected: "sharepoint.oauthReasons.tryAgain",
} as const satisfies Record<SharepointOAuthCallbackReason, TranslationKey>;

const searchSchema = routeSearchSchema({
  // A callback that does not say it connected reports a failure, never a
  // connection; an unknown reason reads as an unexpected failure.
  status: v.optional(v.picklist(["connected", "error"]), "error"),
  reason: v.optional(
    v.picklist(SHAREPOINT_OAUTH_CALLBACK_REASONS),
    "unexpected",
  ),
});

export const Route = createFileRoute("/sharepoint/oauth-callback")({
  staticData: { appFrame: APP_FRAME_SCOPE.none },
  validateSearch: searchSchema,
  head: () => ({
    meta: [{ title: pageTitle("settings.connections.title") }],
  }),
  component: SharepointOAuthCallbackPage,
});

/**
 * Where Microsoft consent ends: report the outcome and return the member to
 * their connections, where the SharePoint row shows the new state.
 */
function SharepointOAuthCallbackPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = Route.useSearch({ select: (search) => search.status });
  const reason = Route.useSearch({ select: (search) => search.reason });

  useMountEffect(() => {
    if (status === "connected") {
      stellaToast.add({ title: t("sharepoint.connected"), type: "success" });
    } else {
      notifyUserProblem(t("sharepoint.connectFailed"), {
        description: t(OAUTH_REASON_KEYS[reason]),
      });
    }
    detached(
      queryClient.invalidateQueries({ queryKey: sharepointKeys.root() }),
      "sharepoint-oauth-callback.invalidate",
    );
    detached(
      navigate({ to: "/settings/account/connections", replace: true }),
      "sharepoint-oauth-callback.navigate",
    );
  });

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Loader label={t("common.loading")} />
    </div>
  );
}
