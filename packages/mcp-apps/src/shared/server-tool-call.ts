import type { App } from "@modelcontextprotocol/ext-apps";
import { Result } from "better-result";
import * as v from "valibot";

export type AppToolResult = Awaited<ReturnType<App["callServerTool"]>>;

type AppServerToolCall =
  | { status: "answered"; result: AppToolResult }
  | { status: "unreachable"; error: unknown };

const errorEnvelopeSchema = v.union([
  v.looseObject({ error: v.looseObject({ code: v.string() }) }),
  v.looseObject({ appFailure: v.looseObject({ type: v.string() }) }),
]);

const rejectedToolResultSchema = v.looseObject({
  isError: v.literal(true),
  structuredContent: v.optional(v.unknown()),
  content: v.optional(
    v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
  ),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isError(parsed) ? undefined : parsed.value;
};

/** The tool error a payload carries, as the tool result the server sent. */
const toolErrorResult = (payload: unknown): AppToolResult | undefined => {
  if (v.is(errorEnvelopeSchema, payload)) {
    return {
      isError: true,
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  }
  const rejected = v.safeParse(rejectedToolResultSchema, payload);
  if (!rejected.success) {
    return undefined;
  }
  const { structuredContent, content } = rejected.output;
  if (structuredContent !== undefined) {
    return toolErrorResult(structuredContent);
  }
  const text = content?.find((part) => part.type === "text")?.text;
  return text === undefined ? undefined : toolErrorResult(parseJson(text));
};

// JSON-RPC errors carry `{ code, message, data }`; the SDK prefixes the
// message with `MCP error <code>: `.
const MCP_ERROR_PREFIX = /^MCP error -?\d+: /u;

/**
 * A host can answer a tool's error result by rejecting the call instead of
 * resolving it with `isError`. When the rejection carries the server's error,
 * in its JSON-RPC `data` or serialized in its message, that error is the
 * answer; only a rejection without one means the server was never reached.
 */
const rejectedServerToolResult = (
  error: unknown,
): AppToolResult | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  const fromData = toolErrorResult(error["data"]);
  if (fromData !== undefined) {
    return fromData;
  }
  const message = error["message"];
  return typeof message === "string"
    ? toolErrorResult(parseJson(message.replace(MCP_ERROR_PREFIX, "")))
    : undefined;
};

/** The one place an app calls a server tool through its host. */
export const callAppServerTool = async (
  app: Pick<App, "callServerTool">,
  params: Parameters<App["callServerTool"]>[0],
): Promise<AppServerToolCall> => {
  const called = await Result.tryPromise({
    try: async () => await app.callServerTool(params),
    catch: (rejection): unknown => rejection,
  });
  if (Result.isOk(called)) {
    return { status: "answered", result: called.value };
  }
  const result = rejectedServerToolResult(called.error);
  return result === undefined
    ? { status: "unreachable", error: called.error }
    : { status: "answered", result };
};
