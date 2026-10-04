import { useTranslations } from "use-intl";

import type { CorrespondenceProvenance as Provenance } from "@stll/api-contract/correspondence";

import { correspondenceProvenancePresentation } from "./correspondence-provenance.logic";

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

export const OriginalSignature = ({ domain }: { domain: string | null }) => {
  const t = useTranslations();
  if (domain === null) {
    return null;
  }
  return (
    <span className="block">
      {t.rich("correspondence.originalSignatureVerified", {
        domain,
        identifier: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
      })}
    </span>
  );
};
