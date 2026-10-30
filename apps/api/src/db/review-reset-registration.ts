import { Result } from "better-result";

import { requireMigrationReviewOrganizationConfig } from "../lib/review-organization/env";
import type { OnlineRepair } from "./online-migration-connection";

/** Only the migration connection registers reset authority. */
export const REVIEW_RESET_REGISTRATION: OnlineRepair = {
  introducedBy: "20261030200519_registered_review_reset",
  name: "review-reset-registration",
  readCompletion: async (connection) => {
    const config = requireMigrationReviewOrganizationConfig();
    if (Result.isError(config)) {
      throw config.error;
    }
    const { organizationId } = config.value;
    const rows = await connection.query(
      "SELECT organization_id FROM public.review_reset_organizations WHERE organization_id = $1",
      [organizationId],
    );
    return rows.length === 1
      ? { type: "complete" }
      : {
          type: "incomplete",
          reason: "The review organization awaits registration",
        };
  },
  repair: async (connection) => {
    const config = requireMigrationReviewOrganizationConfig();
    if (Result.isError(config)) {
      throw config.error;
    }
    const { organizationId } = config.value;
    await connection.execute("BEGIN");
    const result = await Result.tryPromise(async () => {
      await connection.execute("SET LOCAL lock_timeout = '1s'");
      await connection.execute("SET LOCAL statement_timeout = '10s'");
      await connection.query(
        `INSERT INTO public.review_reset_organizations (organization_id)
         VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`,
        [organizationId],
      );
      await connection.execute("COMMIT");
    });
    if (Result.isError(result)) {
      await connection.execute("ROLLBACK");
      throw result.error;
    }
    return { type: "complete" };
  },
};
