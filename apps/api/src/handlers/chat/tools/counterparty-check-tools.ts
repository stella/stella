import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";

import type {
  EntityCheckResult,
  runEntityCheck,
} from "@stll/business-registries/entity-checks";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { runEntityCheckShared } from "@/api/lib/business-registries/entity-checks";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  CHECK_COUNTERPARTY_INPUT_SCHEMA,
  toEntityCheckSubject,
} from "@/api/mcp/matter-tools";

export const COUNTERPARTY_CHECK_TOOL_NAME = "counterparty_check" as const;

const TOOL_DESCRIPTION =
  "Screen a company or a person against an official register for due " +
  "diligence. The result status is clear (the register answered and lists " +
  "nothing adverse), found (the adverse records), not-registered (the " +
  "register holds no record, e.g. not a VAT payer; not a clearance), " +
  "unavailable (the register did not answer: the subject is NOT cleared; " +
  "say the check could not run), or not-covered (the register cannot " +
  "screen this subject type). Person matches rely on name and birth date: " +
  "compare the record before relying on one.";

type CreateCounterpartyCheckToolsArgs = {
  runCheck?: typeof runEntityCheck | undefined;
};

/**
 * Register the `counterparty_check` chat tool. It takes the same input as
 * the check_counterparty MCP tool. Checks against public registers need no
 * organization configuration, so the tool is always offered.
 */
export const createCounterpartyCheckTools = ({
  runCheck,
}: CreateCounterpartyCheckToolsArgs = {}) => ({
  [COUNTERPARTY_CHECK_TOOL_NAME]: toolDefinition({
    name: COUNTERPARTY_CHECK_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputSchema: toTanStackToolSchema(CHECK_COUNTERPARTY_INPUT_SCHEMA),
  }).server(async ({ check, subject }): Promise<EntityCheckResult> => {
    const result = (
      await runEntityCheckShared({
        check,
        subject: toEntityCheckSubject(subject),
        runCheck,
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
    if (Result.isError(result)) {
      const { error } = result;
      throw error;
    }
    return result.value;
  }),
});
