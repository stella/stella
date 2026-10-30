import { APIError } from "better-auth/api";

import { ORGANIZATION_SLUG_RULES } from "@stll/auth-model";

import { isOrganizationSlugUpdate } from "@/api/lib/auth/organization-slug-update-scope";

type OrganizationSlugUpdateHookArgs = {
  organization: { slug?: string };
  user: { id: string };
  member: { organizationId: string };
};

/** Better Auth consumes a refused organization update through APIError rejection. */
export const beforeOrganizationSlugUpdate = async ({
  organization: { slug },
  user: { id: userId },
  member: { organizationId },
}: OrganizationSlugUpdateHookArgs): Promise<void> => {
  if (
    slug !== undefined &&
    !isOrganizationSlugUpdate({ organizationId, userId, slug })
  ) {
    throw new APIError("BAD_REQUEST", {
      code: "organization_slug_update_required",
      message:
        "Change the slug through the organization slug settings operation.",
    });
  }
  await Promise.resolve();
};

/** Better Auth validates this hook's rejection before creating the organization row. */
export const beforeOrganizationSlugCreation = async ({
  slug,
}: {
  slug: string | undefined;
}): Promise<void> => {
  if (
    slug === undefined ||
    slug.length < ORGANIZATION_SLUG_RULES.minLength ||
    slug.length > ORGANIZATION_SLUG_RULES.maxLength ||
    !ORGANIZATION_SLUG_RULES.pattern.test(slug)
  ) {
    throw new APIError("BAD_REQUEST", {
      message: `Organization slugs must be ${ORGANIZATION_SLUG_RULES.minLength}–${ORGANIZATION_SLUG_RULES.maxLength} lowercase letters, digits or hyphens.`,
    });
  }
  await Promise.resolve();
};
