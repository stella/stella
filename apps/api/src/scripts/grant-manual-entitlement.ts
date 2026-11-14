/**
 * Grant an organization a manually managed plan, or renew its existing one.
 *
 *   bun run src/scripts/grant-manual-entitlement.ts --organization-id <id> \
 *     --usage-policy-id <uuid> --seats <n> --period-ends-at <ISO timestamp> \
 *     --actor <operator> --reason <text>
 *
 * Refused over a hosted entitlement, for a policy that is not a subscription
 * with a service-action budget, and below the current member count. Prints
 * the resulting entitlement as one JSON line; the change is audited.
 */
import { panic, Result } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import {
  parseAuthProviderId,
  parseUsagePolicyId,
} from "@/api/lib/safe-id-boundaries";
import { grantManualEntitlement } from "@/api/lib/usage/manual-entitlement";

const inputSchema = v.strictObject({
  "organization-id": v.pipe(
    v.string(),
    v.check(
      (value) => parseAuthProviderId<"organization">(value) !== null,
      "--organization-id is not an organization ID",
    ),
  ),
  "usage-policy-id": v.pipe(
    v.string(),
    v.check(
      (value) => parseUsagePolicyId(value) !== null,
      "--usage-policy-id is not a usage policy ID",
    ),
  ),
  seats: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,3}$/u), v.transform(Number)),
  "period-ends-at": v.pipe(v.string(), v.isoTimestamp()),
  actor: v.pipe(v.string(), v.minLength(1)),
  reason: v.pipe(v.string(), v.minLength(1)),
});

await runScriptWithErrorOutput(async () => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "organization-id": { type: "string" },
      "usage-policy-id": { type: "string" },
      seats: { type: "string" },
      "period-ends-at": { type: "string" },
      actor: { type: "string" },
      reason: { type: "string" },
    },
    strict: true,
  });
  const input = v.parse(inputSchema, values);
  const db = openMaintenanceDb({ readOnly: false });
  const result = await withAggregateTransaction(
    db,
    async (tx) =>
      await grantManualEntitlement(tx, {
        organizationId:
          parseAuthProviderId<"organization">(input["organization-id"]) ??
          panic("The organization ID was validated above"),
        usagePolicyId:
          parseUsagePolicyId(input["usage-policy-id"]) ??
          panic("The usage policy ID was validated above"),
        seats: input.seats,
        periodEndsAt: new Date(input["period-ends-at"]),
        actor: input.actor,
        reason: input.reason,
      }),
  );
  if (Result.isError(result)) {
    throw result.error;
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
});
