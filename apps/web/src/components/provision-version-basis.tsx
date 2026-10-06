import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ProvisionVersionBasis } from "@stll/api-contract/provision-version-basis";
import { BidiText } from "@stll/ui/bidi-text";

import { formatValidityDate } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";

/** Kept beside each link so inference cannot read as a statement of applied law. */
export const ProvisionVersionBasisLabel = ({
  basis,
}: {
  basis: ProvisionVersionBasis;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  switch (basis.type) {
    case "inferred":
      return (
        <span className="text-muted-foreground text-2xs">
          {t("caseLaw.viewer.versionAtDecisionDateInferred")}
        </span>
      );
    case "not_stated":
      return (
        <span className="text-muted-foreground text-2xs">
          {t("caseLaw.viewer.appliedVersionNotStated")}
        </span>
      );
    case "stated_date":
      return (
        <span className="text-muted-foreground text-2xs">
          {t("caseLaw.viewer.appliedVersionStatedDate", {
            date: formatValidityDate(basis.date, format) ?? basis.date,
            relation: basis.relation,
          })}
        </span>
      );
    case "stated_version":
      return (
        <span className="text-muted-foreground text-2xs">
          {t.rich("caseLaw.viewer.appliedVersionStatedAmendment", {
            amendment: basis.amendmentWorkIdentifier,
            reference: (chunks) => <BidiText>{chunks}</BidiText>,
          })}
        </span>
      );
    default: {
      basis satisfies never;
      return panic("Unknown provision version basis");
    }
  }
};
