import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  SHOW_APP_LIMITS,
  SHOW_APP_TOOL_NAME,
  showAppInputSchema,
  showAppOutputSchema,
} from "@stll/api-contract/stella-mcp-app";
import type {
  ShowAppOutput,
  StellaMcpAppCall,
  StellaMcpAppPart,
} from "@stll/api-contract/stella-mcp-app";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import { chatMcpAppForTool } from "@/api/lib/chat/mcp-app-catalog";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

/** A read this turn ran for a tool a chat app presents. */
export type TurnAppRead = {
  toolName: string;
  call: StellaMcpAppCall;
};

type LedgerEntry = TurnAppRead & { shown: boolean };

/**
 * The reads of one chat turn that an app can show, by the id the turn gave
 * each one. The ledger lives on the turn: an id from another turn, an id
 * the turn never gave, and an id already shown are all refused. Only the
 * server writes it, from the reads it ran.
 */
export const createTurnAppLedger = () => {
  const entries = new Map<string, LedgerEntry>();
  return {
    /** Keep a read and name it, or `undefined` once the turn is full. */
    record: (read: TurnAppRead): string | undefined => {
      if (
        chatMcpAppForTool(read.toolName) === undefined ||
        entries.size >= SHOW_APP_LIMITS.appsPerTurn
      ) {
        return undefined;
      }
      const appId = `app_${String(entries.size + 1)}`;
      entries.set(appId, { ...read, shown: false });
      return appId;
    },
    take: (appId: string): Result<TurnAppRead, ChatToolError> => {
      const entry = entries.get(appId);
      if (entry === undefined) {
        return Result.err(
          new ChatToolError({
            kind: "invalid-input",
            message: `No read of this turn has the app id ${appId}. Pass the appId a read of this turn returned.`,
          }),
        );
      }
      if (entry.shown) {
        return Result.err(
          new ChatToolError({
            kind: "invalid-input",
            message: `The app ${appId} is already shown in this answer.`,
          }),
        );
      }
      entry.shown = true;
      return Result.ok({ toolName: entry.toolName, call: entry.call });
    },
  };
};

export type TurnAppLedger = ReturnType<typeof createTurnAppLedger>;

const SHOW_APP_DESCRIPTION =
  "Show the member one of stella's interactive views for a read you already ran in this turn: " +
  "case-law results (search_case_law), a decision's citations (read_case_law_citations) " +
  "or a provision's history (read_provision_history). " +
  "Each such read returns an appId; return it from your script and pass it as app_id. " +
  "Show a view when the member wants to look through the results or the document themselves, " +
  "for example a decision or a statute they asked to see; answer in text as usual. " +
  "Show each read at most once, and only reads of this turn.";

/**
 * Every app chat shows presents a public-law read, so a deployment without
 * the public corpus offers no `show_app`.
 */
export const SHOW_APP_DEPLOYMENT_FEATURE = "FEATURE_PUBLIC_LAW";

/** What the turn's resource origin offers the tool: minting an app part. */
type AppPartIssuer = {
  issueMcpApp: (options: {
    call: StellaMcpAppCall;
    toolCallId: string;
    toolName: string;
  }) => Result<StellaMcpAppPart, string>;
};

type CreateShowAppToolOptions = {
  ledger: TurnAppLedger;
  origin: AppPartIssuer;
};

export const createShowAppTool = ({
  ledger,
  origin,
}: CreateShowAppToolOptions) => ({
  [SHOW_APP_TOOL_NAME]: toolDefinition({
    name: SHOW_APP_TOOL_NAME,
    description: SHOW_APP_DESCRIPTION,
    inputSchema: toTanStackToolSchema(showAppInputSchema),
    outputSchema: toTanStackToolSchema(showAppOutputSchema),
    // The ledger and the origin are in memory, so the tool answers at once.
  }).server((input, context): ShowAppOutput => {
    if (!context?.toolCallId) {
      return panic("The app tool requires its server execution context");
    }
    const parsed = v.safeParse(showAppInputSchema, input);
    if (!parsed.success) {
      return raiseChatToolError(
        new ChatToolError({
          kind: "invalid-input",
          message: "Pass the app_id a read of this turn returned, like app_1.",
        }),
      );
    }
    const read = ledger.take(parsed.output.app_id);
    if (Result.isError(read)) {
      return raiseChatToolError(read.error);
    }
    const part = origin.issueMcpApp({
      call: read.value.call,
      toolCallId: context.toolCallId,
      toolName: read.value.toolName,
    });
    if (Result.isError(part)) {
      return raiseChatToolError(
        new ChatToolError({
          kind: "invalid-input",
          message:
            "This read is too large to show; answer from its result instead.",
        }),
      );
    }
    context.emitCustomEvent("ui-resource", part.value);
    return { shown: true, tool: read.value.toolName };
  }),
});
