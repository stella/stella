import { APIError } from "better-auth/api";

import { ORGANIZATION_LOGO_RULES } from "@stll/auth-model";

/** Better Auth consumes a refused organization write through APIError rejection. */
export const requireOrganizationLogo = (
  logo: string | null | undefined,
): void => {
  if (
    logo &&
    (logo.length > ORGANIZATION_LOGO_RULES.maxLength ||
      !ORGANIZATION_LOGO_RULES.pattern.test(logo))
  ) {
    throw new APIError("BAD_REQUEST", {
      code: "organization_logo_invalid",
      message: "Organization logos must be a small PNG, JPEG or WebP data URL.",
    });
  }
};
