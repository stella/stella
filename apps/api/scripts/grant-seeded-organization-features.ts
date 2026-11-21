// Dev-only preload the dev runner adds to a seeded stack's API server, so the
// seeded organization sees every invitation feature without a hand-edited
// apps/api/.env. Grants configured in the environment stay in place.
import { requireLocalDevOpen } from "@/api/runtime-mode";

// Refuse before importing the environment-owning modules.
requireLocalDevOpen("Seeded organization feature grants");

const { envFeatureAccess } = await import("@/api/env-feature-access");
const { withSeededOrganizationGrants } =
  await import("./lib/seeded-organization-grants");

envFeatureAccess.API_FEATURE_ACCESS_GRANTS = withSeededOrganizationGrants(
  envFeatureAccess.API_FEATURE_ACCESS_GRANTS,
);
