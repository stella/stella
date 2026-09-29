import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";

import type { runEntityCheck } from "@stll/business-registries/entity-checks";

import type { ScopedDb } from "@/api/db/safe-db";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import type { SafeId } from "@/api/lib/branded-types";
import { runEntityCheckShared } from "@/api/lib/business-registries/entity-checks";
import type { CounterpartyCheckResult } from "@/api/lib/business-registries/entity-checks";
import type { runSanctionsCheck } from "@/api/lib/business-registries/sanctions-check";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  CHECK_COUNTERPARTY_INPUT_SCHEMA,
  toCounterpartyCheckSubject,
} from "@/api/mcp/matter-tools";

export const COUNTERPARTY_CHECK_TOOL_NAME = "counterparty_check" as const;

const TOOL_DESCRIPTION =
  "Screen a company or a person against an official register or the " +
  "sanctions lists for due diligence. A register check's status is clear " +
  "(the register answered and lists nothing adverse), found (the adverse " +
  "records), not-registered (the register holds no record, e.g. not a VAT " +
  "payer; not a clearance), unavailable (the register did not answer: the " +
  "subject is NOT cleared; say the check could not run), or not-covered " +
  "(the register cannot screen this subject type, or needs the tax ID " +
  "because one derived from the company ID was not on file). Person " +
  "matches rely on name and birth date: compare the record before relying " +
  "on one. The sanctions check answers per list: clear, possible-match " +
  "(listed entries resembling the subject, with the identity fields that " +
  "conflict; each needs human review, none is a confirmed hit) or " +
  "unavailable (stale or not loaded, or the company's name could not be " +
  "read from its register: NOT cleared; say which lists could not be " +
  "checked). Name the edition screened and whether each list binds the " +
  "firm or is informational.";

type CreateCounterpartyCheckToolsArgs = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  runCheck?: typeof runEntityCheck | undefined;
  runSanctions?: typeof runSanctionsCheck | undefined;
};

/**
 * Register the `counterparty_check` chat tool. It takes the same input as
 * the check_counterparty MCP tool. Checks against public registers and lists
 * need no organization configuration, so the tool is always offered.
 */
export const createCounterpartyCheckTools = ({
  scopedDb,
  organizationId,
  runCheck,
  runSanctions,
}: CreateCounterpartyCheckToolsArgs) => ({
  [COUNTERPARTY_CHECK_TOOL_NAME]: toolDefinition({
    name: COUNTERPARTY_CHECK_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputSchema: toTanStackToolSchema(CHECK_COUNTERPARTY_INPUT_SCHEMA),
  }).server(async ({ check, subject }): Promise<CounterpartyCheckResult> => {
    const result = (
      await Result.gen(async function* () {
        const checked = yield* toCounterpartyCheckSubject(subject);
        return await runEntityCheckShared({
          check,
          subject: checked,
          runCheck,
          sanctions: {
            scopedDb,
            organizationId,
            runSanctionsCheck: runSanctions,
          },
        });
      })
    ).mapError(
      (error) =>
        new ChatToolError({
          // A rejected subject (a bad IČO checksum, a future birth date) is
          // the model's to correct; a cancelled check may simply be rerun.
          kind: error.status === 400 ? "invalid-input" : "transient",
          message: error.message,
        }),
    );
    return Result.isError(result)
      ? raiseChatToolError(result.error)
      : result.value;
  }),
});
