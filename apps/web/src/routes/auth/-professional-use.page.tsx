import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { PROFESSIONAL_USE_STATEMENT_VERSION } from "@stll/api-contract/professional-use";
import { Button } from "@stll/ui/button";

import { useSignOut } from "@/hooks/use-sign-out";
import { signalSessionChange } from "@/lib/account/session-signal";
import { api } from "@/lib/api";
import { professionalUseOptions } from "@/lib/auth-queries";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { destinationNavigation } from "@/lib/redirect";

import { ProfessionalUseShell } from "./-professional-use.pending";

const routeApi = getRouteApi("/auth/professional-use");

/** Records the displayed statement, then continues to the requested page. */
export const ProfessionalUsePage = () => {
  const userId = routeApi.useRouteContext({
    select: (context) => context.userId,
  });
  const redirectTo = routeApi.useSearch({
    select: (search) => search.redirectTo,
  });
  const t = useTranslations();
  const navigate = routeApi.useNavigate();
  const queryClient = useQueryClient();
  const signOut = useSignOut();

  const accept = useMutation({
    mutationFn: async () =>
      unwrapApiResponse(
        await api.me["professional-use"].post({
          statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
        }),
      ),
    onSuccess: async (state) => {
      queryClient.setQueryData(professionalUseOptions(userId).queryKey, state);
      signalSessionChange();
      await navigate(destinationNavigation(redirectTo));
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <ProfessionalUseShell
      title={t("auth.professionalUse.title")}
      statement={t("auth.professionalUseStatement")}
      signOut={
        <Button
          disabled={accept.isPending || signOut.isPending}
          disabledReason={
            accept.isPending ? t("common.accepting") : t("common.signingOut")
          }
          loading={signOut.isPending}
          onClick={() => signOut.mutate()}
          variant="ghost"
        >
          {t("common.signOut")}
        </Button>
      }
      accept={
        <Button
          disabled={accept.isPending || signOut.isPending}
          disabledReason={
            accept.isPending ? t("common.accepting") : t("common.signingOut")
          }
          loading={accept.isPending}
          onClick={() => accept.mutate()}
        >
          {t("common.accept")}
        </Button>
      }
    />
  );
};
