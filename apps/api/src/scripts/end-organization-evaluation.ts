/**
 * End one organization's running evaluation period ahead of its end time.
 *
 *   bun run src/scripts/end-organization-evaluation.ts <organization-id> --actor <operator>
 *
 * Safe to re-run: an organization whose evaluation already ended, or that
 * never had one, is left unchanged and reported as such.
 */
import { panic } from "better-result";
import { parseArgs } from "node:util";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { endOrganizationEvaluation } from "@/api/lib/usage/organization-access-state";

const USAGE =
  "Usage: end-organization-evaluation.ts <organization-id> --actor <operator>";
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { actor: { type: "string" } },
  allowPositionals: true,
  strict: true,
});
const [rawOrganizationId, ...rest] = positionals;
const organizationId =
  rawOrganizationId !== undefined && rest.length === 0
    ? parseAuthProviderId<"organization">(rawOrganizationId)
    : null;
const actor = values.actor?.trim();
if (organizationId === null || actor === undefined || actor.length === 0) {
  panic(USAGE);
}

const db = openMaintenanceDb({ readOnly: false });
await runScriptWithErrorOutput(async () => {
  const ended = await withAggregateTransaction(
    db,
    async (tx) =>
      await endOrganizationEvaluation(tx, {
        organizationId,
        now: new Date(),
        actor,
      }),
  );

  console.log(
    ended
      ? `Ended the evaluation period of ${organizationId}.`
      : `${organizationId} has no running evaluation period; nothing changed.`,
  );
});
