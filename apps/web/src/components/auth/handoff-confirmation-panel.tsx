import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { HandoffShell } from "@/routes/auth/-handoff.pending";

type HandoffConfirmationPanelProps = {
  email: string;
  organizationName: string;
  submissionStatus: "ready" | "submitting";
  onConfirm: () => void;
  onCancel: () => void;
};

export const useHandoffConfirmationContent = ({
  email,
  organizationName,
  submissionStatus,
  onConfirm,
  onCancel,
}: HandoffConfirmationPanelProps) => {
  const t = useTranslations();
  return {
    title: t("auth.handoffTitle"),
    account: t.rich("auth.handoffAccount", {
      email,
      organizationName,
      account: (chunks) => <bdi>{chunks}</bdi>,
      organization: (chunks) => <bdi>{chunks}</bdi>,
    }),
    confirm: (
      <Button onClick={onConfirm} disabled={submissionStatus === "submitting"}>
        {t("common.confirm")}
      </Button>
    ),
    cancel: (
      <Button
        variant="outline"
        onClick={onCancel}
        disabled={submissionStatus === "submitting"}
      >
        {t("common.cancel")}
      </Button>
    ),
  };
};

export const HandoffConfirmationPanel = (
  props: HandoffConfirmationPanelProps,
) => {
  const content = useHandoffConfirmationContent(props);
  return <HandoffShell {...content} />;
};
