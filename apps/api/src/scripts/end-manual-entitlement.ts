/**
 * End an organization's manually managed plan at a given time (now or later).
 *
 *   bun run src/scripts/end-manual-entitlement.ts --organization-id <id> \
 *     --ends-at <ISO timestamp> --actor <operator> --reason <text>
 *
 * Ending only shortens the period; hosted entitlements are refused. Prints the
 * resulting entitlement as one JSON line; the change is audited.
 */
import { panic, Result } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { endManualEntitlement } from "@/api/lib/usage/manual-entitlement";

const inputSchema = v.strictObject({
  "organization-id": v.pipe(
    v.string(),
    v.check(
      (value) => parseAuthProviderId<"organization">(value) !== null,
      "--organization-id is not an organization ID",
    ),
  ),
  "ends-at": v.pipe(v.string(), v.isoTimestamp()),
  actor: v.pipe(v.string(), v.minLength(1)),
  reason: v.pipe(v.string(), v.minLength(1)),
});

await runScriptWithErrorOutput(async () => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "organization-id": { type: "string" },
      "ends-at": { type: "string" },
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
      await endManualEntitlement(tx, {
        organizationId:
          parseAuthProviderId<"organization">(input["organization-id"]) ??
          panic("The organization ID was validated above"),
        endsAt: new Date(input["ends-at"]),
        actor: input.actor,
        reason: input.reason,
      }),
  );
  if (Result.isError(result)) {
    throw result.error;
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
});
