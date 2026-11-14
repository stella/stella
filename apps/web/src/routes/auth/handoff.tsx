import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { HandoffConfirmationPanel } from "@/components/auth/handoff-confirmation-panel";
import {
  cancelHandoff,
  finishHandoff,
  handoffConfirmation,
} from "@/lib/account/mcp-handoff";
import { notifyUserError } from "@/lib/errors/user-toast";

export const Route = createFileRoute("/auth/handoff")({
  ssr: false,
  beforeLoad: () => {
    const confirmation = handoffConfirmation();
    if (!confirmation) {
      redirect({ to: "/auth", replace: true, throw: true });
      return panic("TanStack Router did not throw the sign-in redirect.");
    }
    return { confirmation };
  },
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  component: HandoffConfirmation,
});

function HandoffConfirmation() {
  const t = useTranslations();
  const confirmation = Route.useRouteContext({
    select: (context) => context.confirmation,
  });
  const confirm = useMutation({
    mutationFn: finishHandoff,
    onError: (error) => notifyUserError(error, t("common.somethingWentWrong")),
  });
  return (
    <HandoffConfirmationPanel
      email={confirmation.email}
      organizationName={confirmation.organizationName}
      submissionStatus={confirm.isPending ? "submitting" : "ready"}
      onConfirm={() => confirm.mutate()}
      onCancel={cancelHandoff}
    />
  );
}
