import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { RenderProvisionPart } from "@/features/case-law/provision-label";

/**
 * The catalog's word for each named subdivision. A switch rather than a key
 * map, so every branch names a literal message and a subdivision the corpus
 * starts recording fails the exhaustiveness check instead of reaching the
 * page unnamed.
 */
export const useProvisionPartRenderer = (): RenderProvisionPart => {
  const t = useTranslations();
  return (key, value) => {
    switch (key) {
      case "article": {
        return t("caseLaw.provision.article", { value });
      }
      case "letter": {
        return t("caseLaw.provision.letter", { value });
      }
      case "openEnded": {
        return t("caseLaw.provision.openEnded");
      }
      case "point": {
        return t("caseLaw.provision.point", { value });
      }
      case "sentence": {
        return t("caseLaw.provision.sentence", { value });
      }
      case "subsection": {
        return t("caseLaw.provision.subsection", { value });
      }
      default: {
        key satisfies never;
        return panic("Unnamed provision subdivision", key);
      }
    }
  };
};
