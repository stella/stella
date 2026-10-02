import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import type { runEntityCheck } from "@stll/business-registries/entity-checks";

import type { ScopedDb } from "@/api/db/safe-db";
import type { RawModeOnlyChatToolName } from "@/api/handlers/chat/tools/raw-mode-only-tools";
import { toRegistryChatToolError } from "@/api/handlers/chat/tools/registry-adapter/registry-tool-error";
import { toToolInputSchema } from "@/api/handlers/chat/tools/registry-adapter/tool-input-schema";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import type { SafeId } from "@/api/lib/branded-types";
import { runEntityCheckShared } from "@/api/lib/business-registries/entity-checks";
import type { CounterpartyCheckResult } from "@/api/lib/business-registries/entity-checks";
import type { runSanctionsCheck } from "@/api/lib/business-registries/sanctions-check";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";
import {
  agentInputValidationError,
  normalizeObjectInputAtBoundary,
} from "@/api/mcp/input-normalization";
import {
  CHECK_COUNTERPARTY_ARGS_SCHEMA,
  toCounterpartyCheckSubject,
} from "@/api/mcp/matter-tools";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { validationErrorResult } from "@/api/mcp/tool-utils";

export const COUNTERPARTY_CHECK_TOOL_NAME =
  "counterparty_check" as const satisfies RawModeOnlyChatToolName;

const MCP_TOOL_NAME = "check_counterparty";

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
  "checked). For a clear or possible-match list, name the edition screened " +
  "and whether the list binds the firm or is informational; an unavailable " +
  "list's edition fields name the latest edition on file, which was not " +
  "screened. Mention a pending update held for review.";

type CreateCounterpartyCheckToolsArgs = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  runCheck?: typeof runEntityCheck | undefined;
  runSanctions?: typeof runSanctionsCheck | undefined;
};

/**
 * Register the `counterparty_check` chat tool. It takes the check_counterparty
 * MCP tool's input through the same boundary: the MCP tool's declared schema
 * reads the agent's spellings (a country's name, a lower-case code, a null
 * placeholder) and the same parser reads the result, so a call either surface
 * accepts the other accepts too. Checks against public registers and lists
 * need no organization configuration, so the tool is always offered.
 */
export const createCounterpartyCheckTools = ({
  scopedDb,
  organizationId,
  runCheck,
  runSanctions,
}: CreateCounterpartyCheckToolsArgs) => {
  const definition =
    getStaticMcpToolDefinition(MCP_TOOL_NAME) ??
    panic(`${MCP_TOOL_NAME} is missing from the static registry`);
  return {
    [COUNTERPARTY_CHECK_TOOL_NAME]: toolDefinition({
      name: COUNTERPARTY_CHECK_TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: toToolInputSchema(definition.inputSchema),
    }).server(async (args: unknown): Promise<CounterpartyCheckResult> => {
      const normalized = normalizeObjectInputAtBoundary({
        access: definition.access,
        schema: definition.inputSchema,
        value: isRecord(args) ? args : {},
      });
      if (!normalized.ok) {
        return raiseChatToolError(
          toRegistryChatToolError(
            agentInputValidationError({
              failure: normalized,
              subject: `${COUNTERPARTY_CHECK_TOOL_NAME} arguments`,
            }).error,
          ),
        );
      }
      const parsed = v.safeParse(
        CHECK_COUNTERPARTY_ARGS_SCHEMA,
        normalized.value,
      );
      if (!parsed.success) {
        return raiseChatToolError(
          toRegistryChatToolError(validationErrorResult(parsed.issues).error),
        );
      }
      const { check, subject } = parsed.output;
      const observer = actionRequestObserver(
        organizationId,
        ACTION_COST_CALL_KIND.registryRequest,
      );
      const result = (
        await Result.gen(async function* () {
          const checked = yield* toCounterpartyCheckSubject(subject);
          return await runEntityCheckShared({
            observer,
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
            message:
              error.hint === undefined
                ? error.message
                : `${error.message}. ${error.hint}`,
          }),
      );
      return Result.isError(result)
        ? raiseChatToolError(result.error)
        : result.value;
    }),
  };
};
