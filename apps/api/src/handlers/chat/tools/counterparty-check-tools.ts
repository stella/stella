import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import type { runEntityCheck } from "@stll/business-registries/entity-checks";

import type { ScopedDb } from "@/api/db/safe-db";
import type { RawModeOnlyChatToolName } from "@/api/handlers/chat/tools/raw-mode-only-tools";
import { toRegistryChatToolError } from "@/api/handlers/chat/tools/registry-adapter/registry-tool-error";
import { toToolInputSchema } from "@/api/handlers/chat/tools/registry-adapter/tool-input-schema";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
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
  "Screen a company or person against registers or sanctions lists. " +
  "Register results: clear, found, not-registered (not a clearance), " +
  "unavailable (not cleared), not-covered. Verify person matches by " +
  "identity. Sanctions: per-list clear, possible-match (human review, " +
  "not a confirmed hit), unavailable (not cleared; name unchecked lists). " +
  "For screened lists cite the edition and binding/informational status; " +
  "unavailable editions were not screened. Mention pending updates.";

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
            permit: grantThirdPartyOutboundPermit(),
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
