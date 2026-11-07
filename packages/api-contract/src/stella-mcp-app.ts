import { panic, Result } from "better-result";
import * as v from "valibot";

/**
 * A chat part that shows one of stella's own MCP Apps beside the tool call
 * that produced it. Unlike an inline MCP App resource it carries no HTML: the
 * app's document is the server's own bundle, fetched by reference when the
 * part renders, so a stored message never holds a copy of an app and an app
 * is never older than the server that serves it. What the part does carry is
 * the call the app presents: its arguments and the tool's own MCP result,
 * both written by the server that ran the tool.
 */
export const STELLA_MCP_APP_MIME_TYPE = "application/vnd.stella.mcp-app+json";

/** Every stella app is served under this prefix (`packages/mcp-apps`). */
export const STELLA_MCP_APP_URI_PREFIX = "ui://stella/";

export const STELLA_MCP_APP_LIMITS = {
  /** The serialized call (arguments and result) one part may hold. */
  payloadChars: 512 * 1024,
  /** Arguments of one call an app makes back through the host. */
  callArgumentsBytes: 64 * 1024,
  toolNameChars: 128,
} as const;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** A plain JSON object: not an array, a class instance or a primitive. */
const jsonRecordSchema = v.custom<Record<string, unknown>>(
  isPlainRecord,
  "Use a plain JSON object.",
);

/**
 * The call an app presents. `result` is the tool's MCP result as an MCP
 * client receives it; only `structuredContent` is kept, because stella's own
 * tools always answer with structured content and their text block is the
 * same object serialized.
 */
export const stellaMcpAppCallSchema = v.strictObject({
  input: jsonRecordSchema,
  result: v.strictObject({ structuredContent: jsonRecordSchema }),
});
export type StellaMcpAppCall = v.InferOutput<typeof stellaMcpAppCallSchema>;

const appUriSchema = v.pipe(
  v.string(),
  v.startsWith(STELLA_MCP_APP_URI_PREFIX),
  v.check(
    (uri) =>
      /^[a-z][a-z0-9-]{0,63}$/u.test(
        uri.slice(STELLA_MCP_APP_URI_PREFIX.length),
      ),
    "Use a stella app resource.",
  ),
);

const toolNameSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9_]*$/u),
  v.maxLength(STELLA_MCP_APP_LIMITS.toolNameChars),
);

const parseCall = (text: string): StellaMcpAppCall | null => {
  if (text.length > STELLA_MCP_APP_LIMITS.payloadChars) {
    return null;
  }
  const decoded = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(decoded)) {
    return null;
  }
  const parsed = v.safeParse(stellaMcpAppCallSchema, decoded.value);
  return parsed.success ? parsed.output : null;
};

export const stellaMcpAppPartSchema = v.strictObject({
  type: v.literal("ui-resource"),
  resource: v.strictObject({
    uri: appUriSchema,
    mimeType: v.literal(STELLA_MCP_APP_MIME_TYPE),
    text: v.pipe(
      v.string(),
      v.check(
        (text) => parseCall(text) !== null,
        "Carry the presented call as bounded JSON.",
      ),
    ),
  }),
  toolCallId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  toolName: toolNameSchema,
});
export type StellaMcpAppPart = v.InferOutput<typeof stellaMcpAppPartSchema>;

/** The presented call of a part that already passed `stellaMcpAppPartSchema`. */
export const readStellaMcpAppCall = (
  part: StellaMcpAppPart,
): StellaMcpAppCall =>
  parseCall(part.resource.text) ??
  // The schema's own check parsed this text; reaching here is a caller that
  // built the part by hand.
  panic("A stella app part carries no readable call");

/**
 * The one way to write a part: serializing here keeps every writer's text in
 * the same canonical form, so a ledger can compare parts by their JSON.
 */
export const buildStellaMcpAppPart = ({
  call,
  toolCallId,
  toolName,
  uri,
}: {
  call: StellaMcpAppCall;
  toolCallId: string;
  toolName: string;
  uri: string;
}): Result<StellaMcpAppPart, string> => {
  const candidate = {
    type: "ui-resource",
    resource: {
      uri,
      mimeType: STELLA_MCP_APP_MIME_TYPE,
      text: JSON.stringify({
        input: call.input,
        result: { structuredContent: call.result.structuredContent },
      }),
    },
    toolCallId,
    toolName,
  } as const;
  const parsed = v.safeParse(stellaMcpAppPartSchema, candidate);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        parsed.issues.at(0)?.message ?? "The app part violates its contract",
      );
};

/** The bundle endpoint's answer: the app's document, served as data. */
export const stellaMcpAppBundleSchema = v.strictObject({
  uri: appUriSchema,
  html: v.pipe(v.string(), v.minLength(1)),
});
export type StellaMcpAppBundle = v.InferOutput<typeof stellaMcpAppBundleSchema>;

/** A `tools/call` an app sends back through the host. */
export const stellaMcpAppToolCallSchema = v.strictObject({
  name: toolNameSchema,
  arguments: v.optional(jsonRecordSchema, {}),
});
export type StellaMcpAppToolCall = v.InferOutput<
  typeof stellaMcpAppToolCallSchema
>;

/** What the host hands the app back: an MCP `CallToolResult`. */
export const stellaMcpAppToolResultSchema = v.strictObject({
  content: v.array(
    v.strictObject({ type: v.literal("text"), text: v.string() }),
  ),
  structuredContent: v.optional(jsonRecordSchema),
  isError: v.optional(v.boolean()),
});
export type StellaMcpAppToolResult = v.InferOutput<
  typeof stellaMcpAppToolResultSchema
>;
