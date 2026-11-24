import * as v from "valibot";

import { ORGANIZATION_NAME_MAX_LENGTH } from "@stll/api-contract/organization-create";
import { ORGANIZATION_SLUG_RULES } from "@stll/auth-model";

import { getTranslator } from "@/i18n/i18n-store";
import { requiredTrimmedStringSchema } from "@/lib/schema";

export const getOrganizationSchema = () => {
  const t = getTranslator();

  return v.strictObject({
    name: v.pipe(
      requiredTrimmedStringSchema(t("validation.organizationNameRequired")),
      v.maxLength(ORGANIZATION_NAME_MAX_LENGTH),
    ),
    slug: v.pipe(
      v.string(),
      v.trim(),
      v.transform((slug) => (slug.length === 0 ? undefined : slug)),
      v.optional(
        v.pipe(
          v.string(),
          v.maxLength(
            ORGANIZATION_SLUG_RULES.maxLength,
            t("validation.slugFormat"),
          ),
          v.regex(ORGANIZATION_SLUG_RULES.pattern, t("validation.slugFormat")),
        ),
      ),
    ),
  });
};
