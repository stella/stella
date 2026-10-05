import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ProvisionVersionBasis } from "@stll/api-contract/provision-version-basis";

/** Kept beside each link so inference cannot read as a statement of applied law. */
export const ProvisionVersionBasisLabel = ({
  basis,
}: {
  basis: ProvisionVersionBasis;
}) => {
  const t = useTranslations();
  const basisType = basis.type;
  switch (basisType) {
    case "inferred":
      return (
        <span className="text-muted-foreground text-2xs">
          {t("caseLaw.viewer.versionAtDecisionDateInferred")}
        </span>
      );
    default: {
      basisType satisfies never;
      return panic("Unknown provision version basis");
    }
  }
};
