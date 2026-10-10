import { useTranslations } from "use-intl";

import type { CorrespondenceProvenance as Provenance } from "@stll/api-contract/correspondence";

import { correspondenceProvenancePresentation } from "./correspondence-provenance.logic";
import { OriginalSignature } from "./original-signature";

export const CorrespondenceProvenance = ({
  record,
}: {
  record: Provenance;
}) => {
  const t = useTranslations();
  const presentation = correspondenceProvenancePresentation(record);
  const { origin } = presentation;
  return (
    <span className="block space-y-1 text-xs">
      <span className="block">
        {origin.type === "delivery"
          ? t.rich(origin.label, {
              sender: origin.sender,
              address: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            })
          : t("correspondence.uploadedFile")}
      </span>
      <OriginalSignature domain={presentation.signatureDomain} />
    </span>
  );
};

export const AssertedHeadersLabel = ({ record }: { record: Provenance }) => {
  const t = useTranslations();
  const { assertedHeadersLabel } = correspondenceProvenancePresentation(record);
  if (assertedHeadersLabel === null) {
    return null;
  }
  return (
    <span className="text-muted-foreground mb-1 block text-xs">
      {t(assertedHeadersLabel)}
    </span>
  );
};
