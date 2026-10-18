import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";

import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { numberSeriesPreviewOptions } from "@/lib/organization/number-series";
import type { NumberSeriesPreviewData } from "@/lib/organization/number-series";

export const NumberSeriesPreviewValue = ({
  preview,
}: {
  preview: NumberSeriesPreviewData;
}) => {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-1">
      <output>
        <BidiText>{preview.number}</BidiText>
      </output>
      {preview.availability === "already_allocated" && (
        <p role="status" className="text-destructive text-sm">
          {t("billing.numberSeries.previewAllocated")}
        </p>
      )}
    </div>
  );
};

export const NumberSeriesPreview = (options: {
  organizationId: string;
  id: string;
  date: string;
}) => {
  const t = useTranslations();
  const query = useQuery(numberSeriesPreviewOptions(options));
  return (
    <div className="flex flex-col gap-1">
      {query.isPending && (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      )}
      {query.error !== null && <NumberSeriesRefusal error={query.error} />}
      {query.data !== undefined && (
        <NumberSeriesPreviewValue preview={query.data} />
      )}
    </div>
  );
};

export const NumberSeriesRefusal = ({ error }: { error: unknown }) => {
  const t = useTranslations();
  return (
    <p role="alert" className="text-destructive text-sm">
      {userErrorFromThrown(error, t("errors.actionFailed"))}
    </p>
  );
};
