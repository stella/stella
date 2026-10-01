import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { ActionAdmissionOutcome } from "@/components/action-admission-outcome";

import { reportExportWithoutAi } from "./export-report-dialog.logic";
import type { ReportExportRequest } from "./export-report-dialog.logic";

export const ReportExportRefusal = ({
  request,
  error,
  onSubmit,
}: {
  request: ReportExportRequest;
  error: unknown;
  onSubmit: (request: ReportExportRequest) => void;
}) => {
  const t = useTranslations();
  const withoutAi = reportExportWithoutAi(request, error);
  return (
    <div className="flex flex-col gap-2">
      <ActionAdmissionOutcome error={error} />
      {withoutAi && (
        <Button
          className="self-start"
          onClick={() => onSubmit(withoutAi)}
          type="button"
          variant="outline"
        >
          {t("workspaces.views.reportExport.withoutAiSummaries")}
        </Button>
      )}
    </div>
  );
};
