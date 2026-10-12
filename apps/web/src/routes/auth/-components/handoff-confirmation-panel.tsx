import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

type HandoffConfirmationPanelProps = {
  email: string;
  organizationName: string;
  submissionStatus: "ready" | "submitting";
  onConfirm: () => void;
  onCancel: () => void;
};

export const HandoffConfirmationPanel = ({
  email,
  organizationName,
  submissionStatus,
  onConfirm,
  onCancel,
}: HandoffConfirmationPanelProps) => {
  const t = useTranslations();
  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">{t("auth.handoffTitle")}</h1>
      <p>
        {t.rich("auth.handoffAccount", {
          email,
          organizationName,
          account: (chunks) => <bdi>{chunks}</bdi>,
          organization: (chunks) => <bdi>{chunks}</bdi>,
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={onConfirm}
          disabled={submissionStatus === "submitting"}
        >
          {t("common.confirm")}
        </Button>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={submissionStatus === "submitting"}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
};
