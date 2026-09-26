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
  return (
    <span className="block space-y-1 text-xs">
      <span className="block">
        {t.rich(presentation.deliveryLabel, {
          sender: presentation.deliverySender,
          address: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
        })}
      </span>
      {presentation.signatureDomain && (
        <span className="block">
          {t.rich("correspondence.originalSignatureVerified", {
            domain: presentation.signatureDomain,
            identifier: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
          })}
        </span>
      )}
    </span>
  );
};
