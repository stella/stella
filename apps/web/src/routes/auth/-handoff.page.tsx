import { useMutation } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { useHandoffConfirmationContent } from "@/components/auth/handoff-confirmation-panel";
import { cancelHandoff, finishHandoff } from "@/lib/account/mcp-handoff";
import { notifyUserError } from "@/lib/errors/user-toast";

import { HandoffShell } from "./-handoff.pending";

const route = getRouteApi("/auth/handoff");

export function HandoffPage() {
  const t = useTranslations();
  const confirmation = route.useRouteContext({
    select: (context) => context.confirmation,
  });
  const confirm = useMutation({
    mutationFn: finishHandoff,
    onError: (error) => notifyUserError(error, t("common.somethingWentWrong")),
  });
  const content = useHandoffConfirmationContent({
    email: confirmation.email,
    organizationName: confirmation.organizationName,
    submissionStatus: confirm.isPending ? "submitting" : "ready",
    onConfirm: () => confirm.mutate(),
    onCancel: cancelHandoff,
  });
  return <HandoffShell {...content} />;
}
