import { useTranslations } from "use-intl";

import type { ProvisionVersionBasis } from "@stll/api-contract/provision-version-basis";

import type { TranslationKey } from "@/i18n/types";

const VERSION_BASIS_LABEL_KEYS = {
  inferred: "caseLaw.viewer.versionAtDecisionDateInferred",
} as const satisfies Record<ProvisionVersionBasis["type"], TranslationKey>;

/** Kept beside each link so inference cannot read as a statement of applied law. */
export const ProvisionVersionBasisLabel = ({
  basis,
}: {
  basis: ProvisionVersionBasis;
}) => {
  const t = useTranslations();
  return (
    <span className="text-muted-foreground text-2xs">
      {t(VERSION_BASIS_LABEL_KEYS[basis.type])}
    </span>
  );
};
