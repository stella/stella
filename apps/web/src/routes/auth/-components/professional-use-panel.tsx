import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { PROFESSIONAL_USE_STATEMENT_VERSION } from "@stll/api-contract/professional-use";
import { Button } from "@stll/ui/button";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";

import { useSignOut } from "@/hooks/use-sign-out";
import { signalSessionChange } from "@/lib/account/session-signal";
import { api } from "@/lib/api";
import { professionalUseOptions } from "@/lib/auth-queries";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";

type ProfessionalUsePanelProps = {
  redirectTo: string;
  userId: string;
};

/** Records the displayed statement, then continues to the requested page. */
export const ProfessionalUsePanel = ({
  redirectTo,
  userId,
}: ProfessionalUsePanelProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
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
      await navigate({ to: redirectTo, replace: true });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <Frame className="w-full max-w-md">
      <FrameHeader>
        <FrameTitle>{t("auth.professionalUse.title")}</FrameTitle>
      </FrameHeader>
      <FramePanel>
        <p className="text-foreground text-sm text-pretty">
          {t("auth.professionalUseStatement")}
        </p>
      </FramePanel>
      <FrameFooter>
        <div className="flex justify-end gap-2">
          <Button
            disabled={accept.isPending || signOut.isPending}
            loading={signOut.isPending}
            onClick={() => {
              signOut.mutate();
            }}
            variant="ghost"
          >
            {t("common.signOut")}
          </Button>
          <Button
            disabled={accept.isPending || signOut.isPending}
            loading={accept.isPending}
            onClick={() => {
              accept.mutate();
            }}
          >
            {t("common.accept")}
          </Button>
        </div>
      </FrameFooter>
    </Frame>
  );
};
