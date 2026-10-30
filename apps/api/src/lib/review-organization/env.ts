import { requireReviewOrganizationConfig } from "./config";

/** The migration task validates its own identity without API-only configuration. */
export const requireMigrationReviewOrganizationConfig = () =>
  requireReviewOrganizationConfig(process.env);
