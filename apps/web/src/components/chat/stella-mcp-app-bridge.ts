import { Result } from "better-result";
import * as v from "valibot";

import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";
import {
  STELLA_MCP_APP_URI_PREFIX,
  stellaMcpAppToolResultSchema,
} from "@stll/api-contract/stella-mcp-app";
import type {
  StellaMcpAppCall,
  StellaMcpAppToolResult,
} from "@stll/api-contract/stella-mcp-app";

/**
 * The host half of the MCP Apps bridge for stella's own apps in chat. The
 * frame (`@mcp-ui/client`'s `AppRenderer`) speaks the protocol; these are the
 * answers it gives: the call the app presents, the tool calls the app sends
 * back, and the links it opens.
 */

/** The app's bundle name: the last segment of its `ui://stella/` resource. */
export const stellaAppDirectory = (uri: string): string | null =>
  uri.startsWith(STELLA_MCP_APP_URI_PREFIX)
    ? uri.slice(STELLA_MCP_APP_URI_PREFIX.length)
    : null;

/** The tool result the app is handed on connect, as an MCP client sees it. */
export const stellaAppToolResult = (
  call: StellaMcpAppCall,
): StellaMcpAppToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(call.result.structuredContent) },
  ],
  structuredContent: call.result.structuredContent,
});

const failedCall = (code: string, message: string): StellaMcpAppToolResult => ({
  content: [
    { type: "text", text: JSON.stringify({ error: { code, message } }) },
  ],
  isError: true,
});

export type StellaAppToolCallRequest = {
  name: string;
  arguments?: Record<string, unknown> | undefined;
};

export type StellaAppServerCall = (request: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

/**
 * Answer an app's `tools/call`. The server decides what the app may run; the
 * host only forwards and checks the answer's shape. The link handoff mints a
 * signed link for an MCP host that is not signed in; a browser in stella is,
 * so the host declines it and the app opens the link as it is.
 */
export const createStellaAppToolCaller =
  (callServer: StellaAppServerCall) =>
  async ({
    name,
    arguments: args,
  }: StellaAppToolCallRequest): Promise<StellaMcpAppToolResult> => {
    if (name === MCP_WEB_HANDOFF_TOOL_NAME) {
      return failedCall("not_found", "Links open directly in stella.");
    }
    const answered = await Result.tryPromise(
      async () => await callServer({ name, arguments: args ?? {} }),
    );
    if (Result.isError(answered)) {
      return failedCall("internal_error", "The app could not reach stella.");
    }
    const parsed = v.safeParse(stellaMcpAppToolResultSchema, answered.value);
    return parsed.success
      ? parsed.output
      : failedCall("internal_error", "stella answered in an unknown shape.");
  };

/**
 * Open a link an app asked for. Only a web link opens, in an isolated window;
 * any other scheme is refused, so an app cannot reach a local handler.
 */
export const openStellaAppLink = (
  url: string,
  open: (href: string) => void,
): { isError?: true } => {
  if (!URL.canParse(url)) {
    return { isError: true };
  }
  const { protocol } = new URL(url);
  if (protocol !== "https:" && protocol !== "http:") {
    return { isError: true };
  }
  open(url);
  return {};
};

/** What the app learns about its host: inline only, in the chat's theme. */
export const stellaAppHostContext = ({
  theme,
  locale,
}: {
  theme: "light" | "dark";
  locale: string;
}) => ({
  theme,
  locale,
  displayMode: "inline" as const,
  availableDisplayModes: ["inline" as const],
});

/** The host runs app tool calls and opens links; nothing else. */
export const STELLA_APP_HOST_CAPABILITIES = {
  serverTools: {},
  openLinks: {},
} as const;
