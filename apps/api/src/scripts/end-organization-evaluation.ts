/**
 * End one organization's running evaluation period ahead of its end time.
 *
 *   bun run src/scripts/end-organization-evaluation.ts <organization-id>
 *
 * Safe to re-run: an organization whose evaluation already ended, or that
 * never had one, is left unchanged and reported as such.
 */
import { panic } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { endOrganizationEvaluation } from "@/api/lib/usage/organization-access-state";

const [rawOrganizationId, ...rest] = process.argv.slice(2);
const organizationId =
  rawOrganizationId !== undefined && rest.length === 0
    ? parseAuthProviderId<"organization">(rawOrganizationId)
    : null;
if (organizationId === null) {
  panic("Usage: end-organization-evaluation.ts <organization-id>");
}

const db = openMaintenanceDb({ readOnly: false });
await runScriptWithErrorOutput(async () => {
  const ended = await db.transaction(
    async (tx) =>
      await endOrganizationEvaluation(tx, { organizationId, now: new Date() }),
  );

  console.log(
    ended
      ? `Ended the evaluation period of ${organizationId}.`
      : `${organizationId} has no running evaluation period; nothing changed.`,
  );
});
