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
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";
import { formatValidityRange } from "@/lib/statutes/statute-format";

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
  // One line of status: the dot leads the sentence on its first line, the
  // sentence wraps as text, and the way back to the current wording trails it.
  return (
    <div className="text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs leading-5">
      <span className="flex h-5 shrink-0 items-center">
        <StatuteStatusDot
          expression={validity.expression}
          status={validity.status}
          validFrom={validity.validFrom}
        />
      </span>
      <p className="m-0 min-w-0 flex-1 text-pretty">
        {t.rich("statutes.versionAppliedInDecision", {
          court: decisionContext.court,
          caseNumber: decisionContext.caseNumber,
          range,
          status,
          bdi: (chunks) => <BidiText as="span">{chunks}</BidiText>,
        })}
      </p>
      {currentVersionId !== undefined && currentVersionId !== documentId && (
        // An underlined text action, like the way into the full text below
        // it, so the status line stays one line of text rather than a toolbar.
        <span className="text-foreground shrink-0">
          <Button
            onClick={() => onVersionChange(currentVersionId)}
            size="inline"
          >
            {t("statutes.currentWording")}
          </Button>
        </span>
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
