import type { ComponentProps } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

import {
  StatuteStatusDot,
  StatuteValidityIndicator,
} from "@/features/statutes/components/statute-validity-indicator";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import { formatValidityRange } from "@/features/statutes/statute-format";
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";

export const ProvisionVersionContext = ({
  decisionContext,
  documentId,
  currentVersionId,
  onVersionChange,
  ...validity
}: ProvisionVersionContextProps) => {
  const t = useTranslations();
  const format = useFormatter();
  if (
    decisionContext === undefined ||
    decisionContext.appliedDocumentId !== documentId
  ) {
    return <StatuteValidityIndicator {...validity} />;
  }
  const displayStatus = resolveStatuteDisplayStatus({
    status: validity.status,
    validFrom: validity.validFrom,
  });
  const statusKey = ineligibleExpressionLabelKey(validity.expression);
  let status = validity.status;
  if (statusKey !== null) {
    status = t(statusKey);
  } else if (displayStatus !== null) {
    status = t(STATUTE_STATUS_LABEL_KEYS[displayStatus]);
  }
  const range = formatValidityRange({
    format,
    openEnded: t("statutes.openEnded"),
    validFrom: validity.validFrom,
    validTo: validity.validTo,
  });
  return (
    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <StatuteStatusDot
        expression={validity.expression}
        status={validity.status}
        validFrom={validity.validFrom}
      />
      <span>
        {t.rich("statutes.versionAppliedInDecision", {
          court: decisionContext.court,
          caseNumber: decisionContext.caseNumber,
          range,
          status,
          bdi: (chunks) => <BidiText as="span">{chunks}</BidiText>,
        })}
      </span>
      {currentVersionId !== undefined && currentVersionId !== documentId && (
        <Button
          size="xs"
          variant="link"
          onClick={() => onVersionChange(currentVersionId)}
        >
          {t("statutes.currentWording")}
        </Button>
      )}
    </div>
  );
};

type ProvisionVersionContextProps = ComponentProps<
  typeof StatuteValidityIndicator
> & {
  decisionContext: ProvisionViewPayload["decisionContext"];
  documentId: string;
  currentVersionId: string | undefined;
  onVersionChange: (documentId: string) => void;
};
