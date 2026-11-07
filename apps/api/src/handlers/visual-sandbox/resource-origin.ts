import type { UIResourcePart } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  GENERATED_VISUAL_MIME_TYPE,
  GENERATED_VISUAL_URI_PREFIX,
  generatedVisualPartSchema,
} from "@stll/api-contract/generated-visual";
import {
  buildStellaMcpAppPart,
  stellaMcpAppPartSchema,
} from "@stll/api-contract/stella-mcp-app";
import type {
  StellaMcpAppCall,
  StellaMcpAppPart,
} from "@stll/api-contract/stella-mcp-app";
import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import type { SafeId } from "@/api/lib/branded-types";
import {
  appPresentsTool,
  chatMcpAppByUri,
  chatMcpAppForTool,
} from "@/api/lib/chat/mcp-app-catalog";

type IssueVisualResourceOptions = {
  fileId: SafeId<"userFile">;
  title: string;
  toolCallId: string;
};

type IssueMcpAppResourceOptions = {
  call: StellaMcpAppCall;
  toolCallId: string;
  toolName: string;
};

type CreateVisualResourceOriginOptions = {
  /** Canonical parts read from the continued assistant's database row. */
  persistedParts?: readonly unknown[];
};

/** A stella app part names a chat app and a tool that app presents. */
const isChatMcpAppPart = (part: StellaMcpAppPart) => {
  const app = chatMcpAppByUri(part.resource.uri);
  return app !== undefined && appPresentsTool(app, part.toolName);
};

const parseServerResource = (candidate: unknown): UIResourcePart | null => {
  const visual = v.safeParse(generatedVisualPartSchema, candidate);
  if (visual.success) {
    return visual.output;
  }
  const app = v.safeParse(stellaMcpAppPartSchema, candidate);
  return app.success && isChatMcpAppPart(app.output) ? app.output : null;
};

/** One ledger key per presented call: the resource and the call it shows. */
const ledgerKey = (part: UIResourcePart) =>
  `${part.toolCallId}\n${part.resource.uri}`;

// Current-turn issuance and canonical stored resources have separate ledgers.
// Client echoes never seed either ledger. A server resource is a generated
// visual or one of stella's own MCP Apps; both are minted only here.
export const createVisualResourceOrigin = ({
  persistedParts = [],
}: CreateVisualResourceOriginOptions = {}) => {
  const issued = new Map<string, string>();
  const persisted = new Map<string, string>();
  for (const candidate of persistedParts) {
    const part = parseServerResource(candidate);
    if (part !== null) {
      persisted.set(ledgerKey(part), JSON.stringify(part));
    }
  }
  return {
    issue: ({ fileId, title, toolCallId }: IssueVisualResourceOptions) => {
      const candidate = {
        type: "ui-resource",
        resource: {
          uri: `${GENERATED_VISUAL_URI_PREFIX}${fileId}`,
          mimeType: GENERATED_VISUAL_MIME_TYPE,
          text: title,
        },
        toolCallId,
        toolName: VISUAL_PREVIEW_TOOL_NAME,
      } as const satisfies UIResourcePart;
      const result = v.safeParse(generatedVisualPartSchema, candidate);
      if (!result.success) {
        return panic("A native visual resource violates its contract");
      }
      const part = result.output;
      issued.set(ledgerKey(part), JSON.stringify(part));
      return part;
    },
    /**
     * Mint the part that shows a stella app for a call the server ran. The
     * caller passes what it holds from that run, never a copy a client sent.
     * A call too large to carry, or a tool no chat app presents, mints
     * nothing; the tool's own result still reaches the chat.
     */
    issueMcpApp: ({
      call,
      toolCallId,
      toolName,
    }: IssueMcpAppResourceOptions): Result<StellaMcpAppPart, string> => {
      const app = chatMcpAppForTool(toolName);
      if (app === undefined) {
        return Result.err(`No chat app presents ${toolName}`);
      }
      const built = buildStellaMcpAppPart({
        call,
        toolCallId,
        toolName,
        uri: app.uri,
      });
      if (Result.isOk(built)) {
        issued.set(ledgerKey(built.value), JSON.stringify(built.value));
      }
      return built;
    },
    accepts: (candidate: unknown) => {
      const part = parseServerResource(candidate);
      if (part === null) {
        return false;
      }
      const serialized = JSON.stringify(part);
      const key = ledgerKey(part);
      return (
        issued.get(key) === serialized || persisted.get(key) === serialized
      );
    },
  };
};

export type VisualResourceOrigin = ReturnType<
  typeof createVisualResourceOrigin
>;
