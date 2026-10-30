import { useTranslations } from "use-intl";

import { ListItemStatus } from "@stll/ui/list";

type DocumentExtractionStatusProps = {
  processingStatus: string | null | undefined;
};

export const DocumentExtractionStatus = ({
  processingStatus,
}: DocumentExtractionStatusProps) => {
  const t = useTranslations();

  if (processingStatus !== "queued" && processingStatus !== "running") {
    return null;
  }

  return (
    <ListItemStatus tone="warning">
      {t("chat.extractingContent")}
    </ListItemStatus>
  );
};

export const readDocumentProcessingStatus = (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("processingStatus" in value)
  ) {
    return null;
  }
  return typeof value.processingStatus === "string"
    ? value.processingStatus
    : null;
};
