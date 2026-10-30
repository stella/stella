import {
  createMcpHandler,
  isInitializeRequest,
  isJsonContentType,
  isLegacyRequest,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type {
  AuthInfo,
  CallToolRequest,
  CallToolResult,
  McpHttpHandler,
  ReadResourceResult,
  RequestId,
  Resource,
  ServerContext,
  Tool as McpTool,
} from "@modelcontextprotocol/server";
import { isTaggedError, panic, Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import type { HandlerExceptionScope } from "@stll/errors";

import { hasRequestBody, reframeBoundedRequest } from "@/api/http/request-body";
import type { BoundedRequest } from "@/api/http/request-body";
import type { captureError as captureApiError } from "@/api/lib/analytics/capture";
import { detached } from "@/api/lib/analytics/capture";
import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { withExceptionScope } from "@/api/lib/observability/exception-scope";
import { failureSink } from "@/api/lib/observability/failure";
import { observeLimiterAdmissionFailure } from "@/api/lib/observability/limiter-admission-failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import {
  actionSizeErrorResponse,
  boundActionJsonResponse,
  boundActionRequest,
  getActionSizePolicy,
  getTenantActionSizePolicy,
  recordActionResponseOversize,
  withTenantActionSizePolicy,
} from "@/api/lib/rate-limit/action-size-limits";
import { chargeMcpReadBytes } from "@/api/lib/rate-limit/mcp-read-fence";
import { isEventStreamResponse, withSseHeartbeat } from "@/api/lib/sse";
import type { SseStreamBinding } from "@/api/lib/sse";
import { mcpActionPeriodIdentity } from "@/api/mcp/action-admission-identity";
import {
  resolveMachineApiKeySession,
  revalidateMachineApiKeySession,
} from "@/api/mcp/api-key-auth";
import type { McpAuthenticationFailure, McpSession } from "@/api/mcp/auth";
import {
  accessibleFeatureCapabilityIds,
  featureOmittedCapabilityIds,
  invokedCapabilityConsumesServices,
} from "@/api/mcp/capability-tools";
import type { RecordMcpSessionInitialized } from "@/api/mcp/client-identity";
import { compatFetchConsumesServices } from "@/api/mcp/compat-tools";
import {
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_NOTIFICATION_KEEP_ALIVE_MS,
  MCP_TOOL_OMISSION_REASONS,
  type McpMode,
  type McpToolOmissionReason,
  STELLA_API_CONTRACT,
  STELLA_MCP_FEATURE_OMITTED_CAPABILITIES_HEADER,
  STELLA_MCP_OMITTED_TOOLS_HEADER_BY_REASON,
  STELLA_MCP_ORGANIZATION_HEADER,
  STELLA_MCP_SCOPES_HEADER,
} from "@/api/mcp/constants";
import type { McpRequestResources } from "@/api/mcp/context";
import {
  type McpAccessRefusalError,
  McpAuthenticationError,
  McpGatewayLoadError,
} from "@/api/mcp/errors";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import type { McpFeatureAccessContext } from "@/api/mcp/feature-access";
import { isMcpToolFeatureEnabled } from "@/api/mcp/gateway/list-tools";
import {
  getSkillPrompt,
  listSkillPrompts,
} from "@/api/mcp/gateway/skill-prompts";
import { hasGrantedScope } from "@/api/mcp/gateway/static-tool-visibility";
import { getMcpInstructions } from "@/api/mcp/instructions";
import {
  jsonRpcRequestId,
  MCP_ACCESS_DENIED_ERROR_CODE,
  MCP_TRANSPORT_ERROR_CODE,
  mcpJsonRpcErrorResponse,
  mcpMethodNotAllowedResponse,
} from "@/api/mcp/json-rpc-error-response";
import {
  createMcpCorsHeaders,
  createMcpPreflightHeaders,
  getMcpServerIcons,
  getMcpWwwAuthenticateHeader,
  type McpChallengeError,
} from "@/api/mcp/metadata";
import { observeMcpToolCall } from "@/api/mcp/observe-tool-call";
import {
  addMcpPhaseDuration,
  measureMcpPhase,
  observeMcpRequest,
  setMcpMetricParsedMethod,
  setMcpMetricProtocolPath,
  setMcpMetricToolName,
} from "@/api/mcp/request-metrics";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { scopeHintToSurface } from "@/api/mcp/surface-tool-mentions";
import { withToolAuthChallenge } from "@/api/mcp/tool-auth-challenge";
import { resolveMcpReadClass } from "@/api/mcp/tool-types";
import type {
  McpReadClass,
  McpToolDefinition,
  ToolScope,
} from "@/api/mcp/tool-types";
import {
  closestToolNames,
  didYouMean,
  MAX_TOOL_NAME_CHARS,
  MCP_INTERNAL_ERROR_HINT,
  oauthScopeRecoveryHint,
  quoteToolName,
  serializeToolResult,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";
import {
  MCP_WEB_HANDOFF_TOOL,
  withWebHandoffLinks,
} from "@/api/mcp/web-handoff-links";
import { omittedWriteToolResult } from "@/api/mcp/write-result-omission";
import { mcpToolAuthorityRefusal } from "@/api/mcp/write-tool-authority";

const responseDisposition = new AsyncLocalStorage<{ type: "read" | "tool" }>();

const mcpStructuredErrorResult = (
  args: Parameters<typeof structuredErrorResult>[0],
): CallToolResult => serializeToolResult(structuredErrorResult(args));

// Only an explicit read hint permits refusal after a tool has run.
const toolResultDisposition = (annotations: McpTool["annotations"]) =>
  annotations?.readOnlyHint === true ? "read" : "mutation";

type ByteStreamReadResult =
  { done: false; value: Uint8Array } | { done: true; value?: undefined };

const isByteStreamReadResult = (
  value: unknown,
): value is ByteStreamReadResult => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { done, value: chunk }: Record<string, unknown> = { ...value };
  return done === true
    ? chunk === undefined
    : done === false && chunk instanceof Uint8Array;
};

const takeStreamReaderOwnership = <T>(body: ReadableStream<T>) =>
  body.getReader();

const formatUnknownToolName = (toolName: string): string =>
  toolName.length <= MAX_TOOL_NAME_CHARS
    ? toolName
    : `${toolName.slice(0, MAX_TOOL_NAME_CHARS)}...`;

/** `missing_scope` envelope with a CLI command that preserves all grants. */
const missingScopeResult = ({
  grantedScopes,
  missingScope,
  requiredScopes,
}: {
  grantedScopes: readonly string[];
  missingScope: ToolScope;
  requiredScopes: readonly ToolScope[];
}): CallToolResult =>
  mcpStructuredErrorResult({
    code: "missing_scope",
    message: `Insufficient permissions. Required scope: ${missingScope}`,
    hint: oauthScopeRecoveryHint({
      grantedScopes,
      missingScope,
      requiredScopes,
    }),
  });

const requiredScopesForTool = (
  definition: McpToolDefinition,
): readonly ToolScope[] => {
  if (definition.additionalScopes === undefined) {
    return [definition.scope];
  }
  return [definition.scope, ...definition.additionalScopes];
};

type McpServerDependencies = {
  admitAction?: typeof withActionAdmission;
  chargeReadBytes?: typeof chargeMcpReadBytes;
  actionSizePolicy?: typeof getActionSizePolicy;
  decorateToolResult?: typeof withWebHandoffLinks;
  authenticateMcpRequest: (
    token: string,
    options: {
      mode: McpMode;
      resolveApiKeySession: typeof resolveMachineApiKeySession;
    },
  ) => Promise<Result<McpSession, McpAuthenticationFailure>>;
  captureError: typeof captureApiError;
  observeTransportFailure?: typeof observeMcpTransportFailure;
  getMcpToolDefinition: (
    toolName: string,
    context: McpRequestResources,
    mode?: McpMode,
  ) => Promise<McpToolDefinition | undefined>;
  getMcpToolRequiredScopesHint: (
    toolName: string,
    mode?: McpMode,
  ) => readonly ToolScope[] | undefined;
  handleMcpToolCall: ({
    args,
    context,
    mode,
    toolName,
  }: {
    args: Record<string, unknown>;
    context: McpRequestResources;
    mode?: McpMode;
    toolName: string;
  }) => Promise<CallToolResult>;
  listMcpTools: (
    context: McpRequestResources,
    mode?: McpMode,
    scopes?: readonly string[],
  ) => Promise<McpTool[]>;
  listMcpResources: (
    mode: McpMode,
    options?: { context?: McpRequestResources | undefined },
  ) => Promise<Resource[]>;
  readMcpResource: (
    uri: string,
    mode: McpMode,
    context?: McpRequestResources,
  ) => ReadResourceResult | Promise<ReadResourceResult>;
  recordMcpSessionInitialized: RecordMcpSessionInitialized;
  resolveMcpSessionContext: (
    session: McpSession,
    options: { clientIp?: string | null; request: Request },
  ) => Promise<McpRequestResources>;
};

// Derived from the public API contract rather than hand-bumped: a client that
// logs `serverInfo.version` then sees the same protocol/revision the CLI
// negotiates against in discovery, and the value cannot go stale on its own.
const MCP_SERVER_VERSION = `${STELLA_API_CONTRACT.protocol}.${STELLA_API_CONTRACT.revision}`;
/**
 * `serverInfo.name` per audience: clients key their saved server entry and
 * their logs off it, so each audience is named, not left to a fallback.
 */
const MCP_SERVER_NAME_BY_MODE = {
  advanced: "stella (advanced)",
  default: "stella",
  documents: "stella (documents)",
  anonymized: "stella (anonymized)",
  law: "stella (law)",
} as const satisfies Record<McpMode, string>;

const getMcpServerName = (mode: McpMode) => MCP_SERVER_NAME_BY_MODE[mode];

const extractBearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
};

/**
 * Every static tool this authenticated `tools/list` projection leaves out,
 * grouped by the one reason that explains it. Computed in a single place so a
 * client can diff its baked-in registry against the projection without reading
 * an unstated omission as a removal it can never reconcile.
 *
 * `feature` wins over `scope`: a tool gated off in this deployment is absent
 * for every caller, whatever the token grants. `scope` names only compound
 * tools, whose local all-scopes preflight the CLI keeps reachable; single-scope
 * tools follow the projection and need no evidence.
 *
 * `isFeatureEnabled` is injected so the reason split can be exercised with a
 * flag off without perturbing `env` for the whole module graph.
 */
export const mcpOmittedToolNamesByReason = ({
  grantedScopes,
  isFeatureEnabled = isMcpToolFeatureEnabled,
  mode,
  context,
}: {
  context?: McpFeatureAccessContext;
  grantedScopes: readonly string[];
  isFeatureEnabled?: (feature: DeploymentFeatureFlag | undefined) => boolean;
  mode: McpMode;
}): Record<McpToolOmissionReason, readonly string[]> => {
  const feature: string[] = [];
  const scope: string[] = [];
  for (const definition of listStaticMcpToolDefinitions(mode)) {
    if (
      !isMcpDescriptorFeatureEnabled({
        context,
        kind: "tools",
        id: definition.name,
        featureId: definition.featureId,
      })
    ) {
      continue;
    }
    if (!isFeatureEnabled(definition.feature)) {
      feature.push(definition.name);
      continue;
    }
    const { additionalScopes } = definition;
    if (
      additionalScopes !== undefined &&
      additionalScopes.length > 0 &&
      !hasGrantedScope(grantedScopes, definition.scope)
    ) {
      scope.push(definition.name);
    }
  }
  return { feature: feature.toSorted(), scope: scope.toSorted() };
};

/** An accepted MCP credential: who it resolved to, and what an event-stream
 *  answer to it stays bound to. */
type McpAuthenticated = { session: McpSession; stream: SseStreamBinding };

const withMcpCors = async (
  response: Response,
  authenticated?: McpAuthenticated,
  mode: McpMode = "default",
) => {
  const session = authenticated?.session;
  const headers = new Headers(response.headers);
  for (const [key, value] of createMcpCorsHeaders()) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  // Echo the authenticated session's identity so a caller holding an opaque
  // machine API key (not a decodable JWT) can confirm which org and scopes it
  // resolves to. Scopes are space-delimited, matching the OAuth scope grammar.
  if (session) {
    headers.set(STELLA_MCP_ORGANIZATION_HEADER, session.organizationId);
    headers.set(STELLA_MCP_SCOPES_HEADER, session.scopes.join(" "));
    const omitted = mcpOmittedToolNamesByReason({
      grantedScopes: session.scopes,
      mode,
    });
    for (const reason of MCP_TOOL_OMISSION_REASONS) {
      headers.set(
        STELLA_MCP_OMITTED_TOOLS_HEADER_BY_REASON[reason],
        omitted[reason].join(" "),
      );
    }
    headers.set(
      STELLA_MCP_FEATURE_OMITTED_CAPABILITIES_HEADER,
      (await featureOmittedCapabilityIds()).join(" "),
    );
  }
  const answer = new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
  // Both transport legs exit here, so this is where an event-stream answer —
  // the notification channel, or a tool call whose work outlasts an
  // intermediary's idle timeout — picks up the keep-alive and its binding to
  // the credential that asked for it.
  if (!isEventStreamResponse(answer)) {
    return answer;
  }
  return authenticated === undefined
    ? panic("An MCP event stream must answer an accepted credential")
    : withSseHeartbeat(answer, authenticated.stream);
};

/**
 * Why access was denied, and how each denial presents on the wire. RFC 6750
 * §3.1: only a presented-and-rejected token carries an `error` code, so a probe
 * that sent nothing is not told its credentials were refused.
 */
const MCP_ACCESS_DENIALS = {
  missing_credentials: {
    challengeError: "none",
    message: "Missing Authorization header",
    status: 401,
  },
  invalid_token: {
    challengeError: "invalid_token",
    message: "Invalid or expired token",
    status: 401,
  },
  // A valid token whose subject cannot reach this organization: no scope grant
  // or re-consent fixes it, so the challenge states no recoverable error.
  organization_forbidden: {
    challengeError: "none",
    message: "Forbidden",
    status: 403,
  },
} as const satisfies Record<
  string,
  { challengeError: McpChallengeError; message: string; status: 401 | 403 }
>;

type McpAccessDenial = keyof typeof MCP_ACCESS_DENIALS;

/**
 * The denial each refusal error answers with, total over
 * `McpAccessRefusalError`: a new refusal kind does not compile without its
 * status here, so it cannot fall through to the retryable server-fault answer.
 */
const MCP_DENIAL_BY_REFUSAL = {
  McpAuthenticationError: "invalid_token",
  McpOrganizationAccessError: "organization_forbidden",
} as const satisfies Record<McpAccessRefusalError["_tag"], McpAccessDenial>;

const isMcpAccessRefusalTag = (
  tag: string,
): tag is keyof typeof MCP_DENIAL_BY_REFUSAL =>
  Object.hasOwn(MCP_DENIAL_BY_REFUSAL, tag);

/** The denial a thrown or returned refusal answers with; none for a fault. */
const accessRefusalDenial = (error: unknown): McpAccessDenial | undefined =>
  isTaggedError(error) && isMcpAccessRefusalTag(error._tag)
    ? MCP_DENIAL_BY_REFUSAL[error._tag]
    : undefined;

const accessDeniedResponse = ({
  denial,
  mode,
  requestId,
}: {
  denial: McpAccessDenial;
  mode: McpMode;
  requestId: RequestId | null;
}) => {
  const { challengeError, message, status } = MCP_ACCESS_DENIALS[denial];
  const headers = createMcpCorsHeaders();
  headers.set(
    "WWW-Authenticate",
    getMcpWwwAuthenticateHeader({ error: challengeError, mode }),
  );

  return mcpJsonRpcErrorResponse({
    code: MCP_ACCESS_DENIED_ERROR_CODE,
    headers,
    id: requestId,
    message,
    status,
  });
};

// Refused from the frame alone, before the body is parsed.
const payloadTooLargeResponse = () =>
  mcpJsonRpcErrorResponse({
    code: MCP_TRANSPORT_ERROR_CODE,
    headers: createMcpCorsHeaders(),
    id: null,
    message: `Payload Too Large: a request body may not exceed ${MCP_MAX_REQUEST_BODY_BYTES} bytes.`,
    status: 413,
  });

/**
 * The vendored transport requires both media types to appear literally in
 * `Accept` and answers 406 otherwise, so it refuses the fully wildcard range
 * (what curl and most HTTP libraries send, and what an absent header means per
 * RFC 9110 §12.5.1) even though it accepts both media types. Every media
 * range that covers each type is spelled out rather than pattern-matched, so a
 * new range is a decision instead of a regex accident.
 */
const MCP_TRANSPORT_MEDIA_TYPES = [
  "application/json",
  "text/event-stream",
] as const;

type McpTransportMediaType = (typeof MCP_TRANSPORT_MEDIA_TYPES)[number];

const MCP_TRANSPORT_ACCEPT_RANGES = {
  "application/json": ["application/json", "application/*", "*/*"],
  "text/event-stream": ["text/event-stream", "text/*", "*/*"],
} as const satisfies Record<McpTransportMediaType, readonly string[]>;

const MCP_TRANSPORT_ACCEPT_HEADER = MCP_TRANSPORT_MEDIA_TYPES.join(", ");

type MediaRangeDisposition = "accepted" | "refused";

/**
 * Every media range the header names, with `q=0` recorded as an explicit
 * refusal (RFC 9110 §12.4.2). A range named twice keeps its first entry.
 */
const mediaRangeDispositions = (
  accept: string,
): Map<string, MediaRangeDisposition> => {
  const dispositions = new Map<string, MediaRangeDisposition>();
  for (const entry of accept.split(",")) {
    const [range, ...parameters] = entry
      .split(";")
      .map((part) => part.trim().toLowerCase());
    if (range === undefined || range.length === 0 || dispositions.has(range)) {
      continue;
    }
    const refused = parameters.some((parameter) => {
      const [name, value] = parameter.split("=");
      return name?.trim() === "q" && Number(value) === 0;
    });
    dispositions.set(range, refused ? "refused" : "accepted");
  }
  return dispositions;
};

/**
 * The most specific range covering a media type decides for it (RFC 9110
 * §12.5.1): JSON at `q=0` beside an accepted wildcard still refuses JSON,
 * and accepted JSON beside a refused wildcard still accepts it. The per-type
 * range lists are ordered most specific first.
 */
const acceptsEveryTransportMediaType = (accept: string): boolean => {
  const dispositions = mediaRangeDispositions(accept);
  return MCP_TRANSPORT_MEDIA_TYPES.every((mediaType) => {
    const decisive = MCP_TRANSPORT_ACCEPT_RANGES[mediaType].find((range) =>
      dispositions.has(range),
    );
    return decisive !== undefined && dispositions.get(decisive) === "accepted";
  });
};

/**
 * Normalize a satisfying `Accept` to the literal pair the transport tests for,
 * and leave a genuinely narrow one untouched so the transport still owns the
 * 406 and its message.
 */
const withTransportAcceptHeader = (request: Request): Request => {
  const accept = request.headers.get("accept");
  if (accept === MCP_TRANSPORT_ACCEPT_HEADER) {
    return request;
  }
  if (accept !== null && !acceptsEveryTransportMediaType(accept)) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set("accept", MCP_TRANSPORT_ACCEPT_HEADER);
  return new Request(request, { headers });
};

type McpRequestFrame =
  { request: Request; status: "within_limit" } | { status: "too_large" };

type DeclaredBodyLength = "undeclared" | "within_limit" | "too_large";

/**
 * What `Content-Length` says about the frame, read from the header alone. A
 * length we cannot read is a length we cannot honour: it is refused rather
 * than falling through to an unmetered read.
 */
const declaredBodyLength = (request: Request): DeclaredBodyLength => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) {
    return "undeclared";
  }
  const length = Number(declaredLength);
  return Number.isInteger(length) && length <= MCP_MAX_REQUEST_BODY_BYTES
    ? "within_limit"
    : "too_large";
};

/**
 * Refuse an oversized JSON-RPC frame before anything parses it. A declared
 * length is checked without touching the body. Every actual stream is metered,
 * including one whose declared length is smaller: parsedBody bypasses the
 * transports' own byte limit. Abandon at the cap and hand on only bounded bytes.
 * A body the action size policy already metered is not read again: its
 * metered size is checked against the cap.
 */
const withCappedRequestBody = async (
  request: Request,
  metered: BoundedRequest | undefined,
): Promise<McpRequestFrame> => {
  if (metered !== undefined) {
    return metered.bytes > MCP_MAX_REQUEST_BODY_BYTES
      ? { status: "too_large" }
      : { request: metered.request, status: "within_limit" };
  }
  const bounded = await reframeBoundedRequest(
    request,
    MCP_MAX_REQUEST_BODY_BYTES,
  );
  return Result.isError(bounded)
    ? { status: "too_large" }
    : { request: bounded.value.request, status: "within_limit" };
};

/**
 * What the handler factory builds a server from: the session and the request
 * context this endpoint resolved before choosing a protocol leg. The factory
 * receives only `{ era, authInfo, requestInfo }`, so the state rides on the
 * exchange's async context. Resolving the context here rather than inside the
 * factory keeps every refusal it raises on this endpoint's side of the SDK
 * boundary, where both legs answer it alike. A factory run without it is a
 * wiring bug, so it panics rather than degrading to an unauthenticated
 * instance.
 */
type McpFactoryState = {
  context: McpRequestResources;
  session: McpSession;
};

const factoryState = new AsyncLocalStorage<McpFactoryState>();

const readFactoryState = (): McpFactoryState => {
  const state = factoryState.getStore();
  if (state === undefined) {
    panic("The MCP handler factory ran without its per-request session state");
  }
  return state;
};

/** Hint (seconds) for a client to back off before retrying a transient fault. */
const MCP_RETRY_AFTER_SECONDS = 2;

/** The exception scope every MCP transport exchange of a mode runs in. */
const mcpTransportExceptionScope = (mode: McpMode): HandlerExceptionScope => ({
  type: "handler",
  handlerId: `mcp.transport.${mode}`,
});

const MCP_TRANSPORT_FAILURE_SINK = failureSink({
  event: "mcp.transport_failed",
  expected: [],
});

/**
 * Observe the server-side fault behind a retryable 5xx. The request is passed
 * so its scope records the failure and the completion log carries the cause.
 */
const observeMcpTransportFailure = (
  error: unknown,
  { mode, request }: { mode: McpMode; request: Request },
): void => {
  observeFailure(error, {
    sink: MCP_TRANSPORT_FAILURE_SINK,
    request,
    scope: mcpTransportExceptionScope(mode),
    ctx: { mode, phase: "transport", source: "mcp" },
  });
};

/**
 * A server-side fault (token-verification infrastructure outage, a bug in
 * session resolution, or a transport failure) is not a bad token: it must not
 * carry `WWW-Authenticate` (which would trigger a re-consent loop) and must not
 * leak internals. A generic, retryable 5xx tells the client to back off and
 * retry; the caller observes the real cause.
 */
const retryableServerErrorResponse = (requestId: RequestId | null) => {
  const headers = createMcpCorsHeaders();
  headers.set("Retry-After", String(MCP_RETRY_AFTER_SECONDS));

  return mcpJsonRpcErrorResponse({
    code: MCP_TRANSPORT_ERROR_CODE,
    headers,
    id: requestId,
    message: "Service temporarily unavailable",
    status: 503,
  });
};

/** JSON-RPC 2.0 parse error, answered when the body cannot be read at all. */
const JSON_RPC_PARSE_ERROR_CODE = -32_700;

type McpInboundMessage =
  | {
      /**
       * The parsed JSON-RPC body, handed to both transports so the body is
       * parsed once per exchange. `undefined` when it is not JSON: the
       * transport then reads `request` and answers the parse error itself.
       */
      parsedBody: unknown;
      request: Request;
      /** The id every error answering this exchange carries. */
      requestId: RequestId | null;
      status: "read";
    }
  | { status: "unreadable" };

const parseJsonBody = (text: string): unknown => {
  if (text.length === 0) {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isOk(parsed) ? parsed.value : undefined;
};

/**
 * Read the JSON-RPC message once, so every response to it (the transports'
 * own and this endpoint's refusals and faults alike) can echo its id. A body
 * that does not parse is handed on as bytes for the transport to refuse.
 */
const readInboundMessage = async (
  request: Request,
): Promise<McpInboundMessage> => {
  if (
    request.method !== "POST" ||
    !hasRequestBody(request) ||
    !isJsonContentType(request.headers.get("content-type"))
  ) {
    return { parsedBody: undefined, request, requestId: null, status: "read" };
  }
  const text = await Result.tryPromise(async () => await request.text());
  if (Result.isError(text)) {
    return { status: "unreadable" };
  }
  const parsedBody = parseJsonBody(text.value);
  return {
    parsedBody,
    request:
      parsedBody === undefined
        ? new Request(request.url, {
            body: text.value,
            headers: request.headers,
            method: request.method,
            signal: request.signal,
          })
        : request,
    requestId: jsonRpcRequestId(parsedBody),
    status: "read",
  };
};

const unreadableBodyResponse = () =>
  mcpJsonRpcErrorResponse({
    code: JSON_RPC_PARSE_ERROR_CODE,
    headers: createMcpCorsHeaders(),
    id: null,
    message: "Parse error: the request body could not be read",
    status: 400,
  });

/**
 * Generic, retryable tool-error envelope for an unexpected failure while
 * handling a `tools/call` (e.g. a gateway load fault surfaced before dispatch).
 * Details never reach the caller; they are captured at the failure site.
 */
const retryableToolErrorResult = (
  mode: McpMode,
  context?: McpFeatureAccessContext,
): CallToolResult =>
  mcpStructuredErrorResult({
    code: "internal_error",
    message:
      "The request could not be completed due to a temporary server error",
    retryable: true,
    hint: scopeHintToSurface(MCP_INTERNAL_ERROR_HINT, { mode, context }),
  });

type BoundMcpToolResultOptions = {
  result: CallToolResult;
  requestId: RequestId;
  definition: McpToolDefinition;
  readClass: McpReadClass | undefined;
  resultDisposition: ReturnType<typeof toolResultDisposition>;
  context: McpRequestResources;
  toolName: string;
  chargeReadBytes: typeof chargeMcpReadBytes;
};

const boundMcpToolResult = async ({
  result,
  requestId,
  definition,
  readClass,
  resultDisposition,
  context,
  toolName,
  chargeReadBytes,
}: BoundMcpToolResultOptions): Promise<CallToolResult> => {
  const policy = getTenantActionSizePolicy();
  const hasOutput =
    result.content.some(
      (block) => block.type !== "text" || block.text.length > 0,
    ) ||
    (result.structuredContent !== undefined &&
      result.structuredContent !== null &&
      (typeof result.structuredContent !== "object" ||
        Object.keys(result.structuredContent).length > 0));
  const fenced =
    isDeploymentFeatureEnabled("FEATURE_MCP_READ_FENCE") &&
    (readClass !== undefined || definition.access === "read") &&
    result.isError !== true &&
    hasOutput;
  if (policy === undefined && !fenced) {
    return result;
  }
  const bytes = Buffer.byteLength(
    JSON.stringify({ jsonrpc: "2.0", id: requestId, result }),
    "utf-8",
  );
  if (policy === undefined || bytes <= policy.responseBytes) {
    if (!fenced) {
      return result;
    }
    if (readClass === undefined) {
      panic("Successful MCP read has no canonical source classification");
    }
    const charged = await chargeReadBytes({
      organizationId: context.organizationId,
      userId: context.userId,
      readClass,
      bytes,
    });
    if (Result.isOk(charged)) {
      return result;
    }
    observeLimiterAdmissionFailure(charged.error, "mcp");
    const refusal = actionAdmissionRefusal(charged.error);
    return mcpStructuredErrorResult({
      code: refusal.code,
      message: refusal.message,
      hint: refusal.hint,
      contactUrl: refusal.contactUrl,
      retryable: ACTION_ADMISSION_REFUSALS[refusal.code].retryable,
      retryAfterMs: refusal.retryAfterMs,
    });
  }
  recordActionResponseOversize({
    transport: "mcp",
    operation: toolName,
    bytes,
    maximum: policy.responseBytes,
  });
  if (resultDisposition === "read" || result.isError === true) {
    return mcpStructuredErrorResult({
      code: "result_too_large",
      message: "Tool result exceeds the configured byte limit",
      hint: "Request a smaller selection using this tool's filters or page limit.",
    });
  }
  // Every write tool advertises this shape beside its own output.
  return omittedWriteToolResult();
};

export const createMcpHttpRequestHandler = ({
  admitAction = withActionAdmission,
  chargeReadBytes = chargeMcpReadBytes,
  actionSizePolicy = getActionSizePolicy,
  decorateToolResult = withWebHandoffLinks,
  authenticateMcpRequest,
  captureError,
  observeTransportFailure = observeMcpTransportFailure,
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  listMcpResources,
  listMcpTools,
  readMcpResource,
  recordMcpSessionInitialized,
  resolveMcpSessionContext,
}: McpServerDependencies) => {
  type ToolsCallRequestOptions = {
    toolRequest: CallToolRequest;
    requestContext: ServerContext;
    context: McpRequestResources;
    mode: McpMode;
    session: McpSession;
  };
  const handleToolsCallRequest = async ({
    toolRequest,
    requestContext: { mcpReq },
    context,
    mode,
    session,
  }: ToolsCallRequestOptions) => {
    const disposition = responseDisposition.getStore();
    if (disposition !== undefined) {
      disposition.type = "tool";
    }
    const toolName = toolRequest.params.name;
    const staticTool = listStaticMcpToolDefinitions(mode).find(
      ({ name }) => name === toolName,
    );
    const requiredScopesHint = isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: toolName,
      featureId: staticTool?.featureId,
    })
      ? getMcpToolRequiredScopesHint(toolName, mode)
      : undefined;
    const missingHintedScope = requiredScopesHint?.find(
      (scope) => !hasGrantedScope(session.scopes, scope),
    );
    if (missingHintedScope !== undefined && requiredScopesHint !== undefined) {
      return missingScopeResult({
        grantedScopes: session.scopes,
        missingScope: missingHintedScope,
        requiredScopes: requiredScopesHint,
      });
    }

    // Resolving a dynamic-gateway tool reads the backing store. A load fault
    // (`McpGatewayLoadError`) must not collapse into `unknown_tool`: answer a
    // transient outage with a retryable `internal_error` so the caller retries
    // instead of treating the tool as gone. The underlying failure is captured
    // at the load site, so it is not re-captured here.
    let definition: McpToolDefinition | undefined;
    try {
      definition = await getMcpToolDefinition(toolName, context, mode);
    } catch (error) {
      // A gateway load fault is already captured at the load site; anything
      // else is unexpected here and must be captured before it degrades to a
      // generic retryable result.
      if (!(error instanceof McpGatewayLoadError)) {
        captureError(
          error,
          handlerErrorContext(
            "createMcpHttpRequestHandler.handleToolsCallRequest.error",
            {
              phase: "tools/call",
              mode,
              source: "mcp",
            },
          ),
        );
      }
      return retryableToolErrorResult(mode, context);
    }
    if (!definition) {
      // Suggest the closest names the caller can actually see (scope-filtered
      // list), so a typo resolves without leaking tools they lack access to.
      const suggestions =
        toolName.length <= MAX_TOOL_NAME_CHARS
          ? closestToolNames(
              toolName,
              (await listMcpTools(context, mode, session.scopes)).map(
                (tool) => tool.name,
              ),
            )
          : [];
      return mcpStructuredErrorResult({
        code: "unknown_tool",
        message: `Unknown tool: ${formatUnknownToolName(toolName)}`,
        hint:
          suggestions.length > 0
            ? `No such tool. ${didYouMean(suggestions.map(quoteToolName))} Call tools/list for the full set.`
            : "No such tool. Call tools/list for the tools available to this session.",
      });
    }

    setMcpMetricToolName(definition.name, mode);

    const requiredScopes = requiredScopesForTool(definition);
    const missingScope = requiredScopes.find(
      (scope) => !hasGrantedScope(session.scopes, scope),
    );
    if (missingScope !== undefined) {
      return missingScopeResult({
        grantedScopes: session.scopes,
        missingScope,
        requiredScopes,
      });
    }

    // Before admission: an unauthorized call must not spend the caller's
    // action budget, nor be answered with an admission refusal instead.
    const authorityRefusal = mcpToolAuthorityRefusal({
      authority: context,
      definition,
      toolName,
      userEmail: context.userEmail,
    });
    if (authorityRefusal !== null) {
      return mcpStructuredErrorResult(authorityRefusal);
    }

    const resultDisposition = toolResultDisposition(definition.annotations);
    const readClass = isDeploymentFeatureEnabled("FEATURE_MCP_READ_FENCE")
      ? await resolveMcpReadClass(
          definition,
          toolRequest.params.arguments ?? {},
        )
      : undefined;
    const run = async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const result = await measureMcpPhase(
        "dispatch",
        async () =>
          await handleMcpToolCall({
            args: toolRequest.params.arguments ?? {},
            context,
            mode,
            toolName,
          }),
      );
      const decoratedResult =
        toolName === MCP_WEB_HANDOFF_TOOL || mode === "anonymized"
          ? result
          : await decorateToolResult(result, context);
      return await boundMcpToolResult({
        result: decoratedResult,
        requestId: mcpReq.id,
        definition,
        readClass,
        resultDisposition,
        context,
        toolName,
        chargeReadBytes,
      });
    };
    let consumesServices = definition.consumesServices;
    if (
      toolName === MCP_CAPABILITY_EXECUTORS.read ||
      toolName === MCP_CAPABILITY_EXECUTORS.write
    ) {
      const classified = await invokedCapabilityConsumesServices({
        args: toolRequest.params.arguments ?? {},
        context,
        access: toolName === MCP_CAPABILITY_EXECUTORS.read ? "read" : "write",
      });
      if (Result.isError(classified)) {
        return serializeToolResult(classified.error);
      }
      consumesServices = classified.value;
    } else if (toolName === "fetch" && mode !== "law") {
      consumesServices = compatFetchConsumesServices(
        toolRequest.params.arguments ?? {},
      );
    }
    const admitted = await admitAction({
      organizationId: context.organizationId,
      userId: context.userId,
      organizationStateDb: context.scopedDb,
      periodIdentity: mcpActionPeriodIdentity(consumesServices),
      run,
    });
    if (Result.isOk(admitted)) {
      return admitted.value;
    }
    if (ActionAdmissionError.is(admitted.error)) {
      observeLimiterAdmissionFailure(admitted.error, "mcp");
      const refusal = actionAdmissionRefusal(admitted.error);
      return mcpStructuredErrorResult({
        code: refusal.code,
        message: refusal.message,
        hint: refusal.hint,
        contactUrl: refusal.contactUrl,
        retryable: ACTION_ADMISSION_REFUSALS[refusal.code].retryable,
        retryAfterMs: refusal.retryAfterMs,
      });
    }
    captureError(
      admitted.error,
      handlerErrorContext(
        "createMcpHttpRequestHandler.handleToolsCallRequest.admitted_error",
        {
          phase: "action-admission",
          source: "mcp",
        },
      ),
    );
    return retryableToolErrorResult(mode, context);
  };

  const createMcpServer = async ({
    context,
    mode,
    session,
  }: {
    context: McpRequestResources;
    mode: McpMode;
    session: McpSession;
  }) => {
    const serverBuildStartedAt = performance.now();
    // The low-level Server API accepts JSON Schema directly, which keeps the
    // MCP surface independent from the chat tool generics used elsewhere.
    // oxlint-disable-next-line typescript/no-deprecated -- low-level Server is the intended "advanced use case" API per the SDK; McpServer would couple us to chat tool generics
    const server = new Server(
      {
        icons: getMcpServerIcons(),
        name: getMcpServerName(mode),
        version: MCP_SERVER_VERSION,
      },
      {
        capabilities: { prompts: {}, resources: {}, tools: {} },
        instructions: await getMcpInstructions(mode, context),
      },
    );

    server.setRequestHandler("tools/list", async (listRequest) => {
      setMcpMetricParsedMethod(listRequest.method);
      const tools = await measureMcpPhase(
        "tool_projection",
        async () => await listMcpTools(context, mode, session.scopes),
      );
      return {
        tools,
        _meta: {
          featureAccess: {
            capabilities: await accessibleFeatureCapabilityIds(context),
            tools: tools
              .filter((tool) => typeof tool._meta?.["featureId"] === "string")
              .map(({ name }) => name),
          },
        },
      };
    });

    // Resources are static, public, tenant-independent documents (the template
    // marker grammar today); the same set is served in both modes without a
    // per-tool scope gate. Every request already carries a valid session token.
    server.setRequestHandler("resources/list", async () => ({
      resources: await listMcpResources(mode, { context }),
    }));

    server.setRequestHandler(
      "resources/read",
      async (resourceRequest) =>
        await readMcpResource(resourceRequest.params.uri, mode, context),
    );

    // Prompts are the skills that run only when the user invokes them: a
    // client offers a prompt for the user to start, never to the model.
    server.setRequestHandler("prompts/list", async () => ({
      prompts: await listSkillPrompts({
        context,
        mode,
        scopes: session.scopes,
      }),
    }));

    server.setRequestHandler("prompts/get", async (promptRequest) => {
      const prompt = await getSkillPrompt({
        args: promptRequest.params.arguments,
        context,
        mode,
        name: promptRequest.params.name,
      });
      if (Result.isError(prompt)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          prompt.error.message,
        );
      }
      return prompt.value;
    });

    server.setRequestHandler(
      "tools/call",
      async (toolRequest, requestContext) => {
        setMcpMetricParsedMethod(toolRequest.method);
        return await observeMcpToolCall({
          context,
          mode,
          toolName: toolRequest.params.name,
          run: async () =>
            withToolAuthChallenge(
              await handleToolsCallRequest({
                toolRequest,
                requestContext,
                context,
                mode,
                session,
              }),
              mode,
            ),
        });
      },
    );

    addMcpPhaseDuration(
      "server_build",
      performance.now() - serverBuildStartedAt,
    );

    return server;
  };

  // One handler per mode, built once. The handler owns per-request instance
  // lifetime; building one per request would put teardown back on our side of
  // the boundary, which is the mistake this replaces.
  //
  // `legacy: "reject"` because the built-in fallback answers 2025-era requests
  // with an SSE stream, and this endpoint has always answered them with a
  // single JSON body. Published CLI releases parse that body as JSON, so the
  // shape is a compatibility promise, not an implementation detail; legacy
  // traffic is served below instead.
  const handlers = new Map<McpMode, McpHttpHandler>();
  const handlerForMode = (mode: McpMode): McpHttpHandler => {
    const existing = handlers.get(mode);
    if (existing) {
      return existing;
    }

    const handler = createMcpHandler(
      async () => await createMcpServer({ ...readFactoryState(), mode }),
      {
        legacy: "reject",
        // The v2 handler converts factory/dispatch exceptions into responses
        // internally, so they never reach the outer transport catch. Preserve
        // the endpoint's observability contract through the handler's reporting
        // hook; the response is normalized to the retryable contract below.
        onerror: (error) => {
          captureError(
            error,
            handlerErrorContext(
              "createMcpHttpRequestHandler.handlerForMode.handler.error",
              { phase: "transport", mode, source: "mcp" },
            ),
          );
        },
      },
    );
    handlers.set(mode, handler);
    return handler;
  };

  /**
   * The 2025-era leg uses a fresh server and transport for every request. POST
   * responses are buffered and can be torn down immediately. GET is different:
   * ChatGPT opens the optional notification channel and treats a 405 as a dead
   * connector, so its server and transport live exactly as long as the returned
   * SSE body. No state is shared between that channel and later POST requests.
   */
  const serveLegacyRequest = async ({
    authInfo,
    context,
    mode,
    parsedBody,
    request,
    session,
  }: {
    authInfo: AuthInfo;
    context: McpRequestResources;
    mode: McpMode;
    parsedBody: unknown;
    request: Request;
    session: McpSession;
  }): Promise<Response> => {
    const server = await createMcpServer({ context, mode, session });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      keepAliveMs: MCP_NOTIFICATION_KEEP_ALIVE_MS,
    });
    // Where a session's client names itself: the SDK classifies `initialize`
    // as 2025-era whatever revision it claims, so every handshake arrives on
    // this leg. `connect` chains this observer ahead of its own dispatch, and
    // the instance is per-request, so the identity is recorded once per
    // handshake rather than once per call. Modern-era requests carry the
    // identity in each request's `_meta` envelope instead and open no session.
    //
    // The transport is not an `EventTarget` and exposes only this callback
    // slot, so `Reflect.set` performs the assignment the
    // `prefer-add-event-listener` rule bans, as `redis-client.ts` does for
    // Bun's client. The handler is typed from the slot it fills.
    const observeHandshake: NonNullable<typeof transport.onmessage> = (
      message,
    ) => {
      if ("method" in message) {
        setMcpMetricParsedMethod(message.method);
      }
      if (!isInitializeRequest(message)) {
        return;
      }
      // Telemetry does not decide whether a handshake succeeds. This callback
      // runs inside `handleRequest`, so a throwing analytics sink would reject
      // it and answer a valid `initialize` with a 503. Convert the failure to a
      // result and report it rather than swallowing it.
      const recorded = Result.try({
        try: () =>
          recordMcpSessionInitialized({
            clientInfo: message.params.clientInfo,
            capabilities: message.params.capabilities,
            mode,
            session,
          }),
        catch: (cause) => cause,
      });
      if (recorded.isErr()) {
        captureError(
          recorded.error,
          handlerErrorContext(
            "createMcpHttpRequestHandler.serveLegacyRequest.observeHandshake.recorded_error",
            {
              phase: "initialize",
              mode,
              source: "mcp",
            },
          ),
        );
      }
    };
    Reflect.set(transport, "onmessage", observeHandshake);
    const reportTransportError = (
      error: unknown,
      operation:
        "close_transport" | "close_server" | "cancel_stream" | "read_stream",
    ) => {
      captureError(
        error,
        handlerErrorContext(`mcp.legacyTransport.${operation}`, {
          mode,
          operation,
          phase: "transport",
          source: "mcp",
        }),
      );
    };

    let toreDown = false;
    const teardown = async () => {
      if (toreDown) {
        return;
      }
      toreDown = true;
      const [transportResult, serverResult] = await Promise.allSettled([
        transport.close(),
        server.close(),
      ]);
      if (transportResult.status === "rejected") {
        reportTransportError(transportResult.reason, "close_transport");
      }
      if (serverResult.status === "rejected") {
        reportTransportError(serverResult.reason, "close_server");
      }
    };

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        authInfo,
        parsedBody,
      });
      if (response.body === null || !isEventStreamResponse(response)) {
        await teardown();
        return response;
      }

      const reader = takeStreamReaderOwnership(response.body);
      let readerReleased = false;
      const completeExchange = async () => {
        request.signal.removeEventListener("abort", abortExchange);
        if (!readerReleased) {
          reader.releaseLock();
          readerReleased = true;
        }
        await teardown();
      };
      const abortExchange = () => {
        detached(
          (async () => {
            try {
              await reader.cancel(request.signal.reason);
            } catch (error) {
              reportTransportError(error, "cancel_stream");
            } finally {
              await completeExchange();
            }
          })(),
          "mcp.legacy-stream-teardown",
        );
      };
      request.signal.addEventListener("abort", abortExchange, {
        once: true,
      });

      // A pull is suspended across the upstream read and the teardown that
      // follows it, and the consumer can cancel `monitoredBody` during either
      // await. Cancelling closes the controller, so the close/enqueue that
      // resumes afterwards throws, and the catch below would report that as a
      // failed transport read. A cancelled body is a normal end of the
      // exchange, so absorb the closed-controller throw here, the way the SSE
      // connection registries do, and leave the catch for real read failures.
      const closeMonitoredBody = (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ): void => {
        try {
          controller.close();
        } catch {
          // Already closed by a concurrent cancel.
        }
      };
      const enqueueMonitoredChunk = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        chunk: Uint8Array,
      ): void => {
        try {
          controller.enqueue(chunk);
        } catch {
          // Already closed by a concurrent cancel.
        }
      };

      const monitoredBody = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (readerReleased) {
            closeMonitoredBody(controller);
            return;
          }
          try {
            const readResult: unknown = await reader.read();
            if (!isByteStreamReadResult(readResult)) {
              panic("MCP transport returned a non-byte stream");
            }
            if (readResult.done) {
              await completeExchange();
              closeMonitoredBody(controller);
              return;
            }
            enqueueMonitoredChunk(controller, readResult.value);
          } catch (error) {
            reportTransportError(error, "read_stream");
            await completeExchange();
            controller.error(error);
          }
        },
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } catch (error) {
            reportTransportError(error, "cancel_stream");
          } finally {
            await completeExchange();
          }
        },
      });

      return new Response(monitoredBody, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (error) {
      await teardown();
      throw error;
    }
  };

  // Only a genuine token rejection gets a 401 + `WWW-Authenticate`. Anything
  // else (a token-verification infrastructure outage surfaced as
  // `McpTokenVerificationError`, a bug in session resolution, or a transport
  // fault) is a server-side problem, not a bad token: observe it and return
  // a retryable 5xx so the client backs off instead of dropping into a
  // re-consent loop. Every answer carries the id of the request once its
  // body has been read.
  type FailureResponseOptions = {
    error: unknown;
    mode: McpMode;
    request: Request;
    requestId: RequestId | null;
  };
  const failureResponse = ({
    error,
    mode,
    request,
    requestId,
  }: FailureResponseOptions): Response => {
    const denial = accessRefusalDenial(error);
    if (denial !== undefined) {
      return accessDeniedResponse({ denial, mode, requestId });
    }

    observeTransportFailure(error, { mode, request });

    return retryableServerErrorResponse(requestId);
  };

  return async (
    incomingRequest: Request,
    {
      clientIp = null,
      mode = "default",
    }: { clientIp?: string | null | undefined; mode?: McpMode } = {},
  ): Promise<Response> =>
    await withExceptionScope(
      mcpTransportExceptionScope(mode),
      async () =>
        await observeMcpRequest({
          method: incomingRequest.headers.get("mcp-method"),
          mode,
          run: async () => {
            if (incomingRequest.method === "OPTIONS") {
              return new Response(null, {
                headers: createMcpPreflightHeaders(),
                status: 204,
              });
            }

            const configuredPolicy = actionSizePolicy();
            if (Result.isError(configuredPolicy)) {
              return withMcpCors(
                actionSizeErrorResponse(configuredPolicy.error),
                undefined,
                mode,
              );
            }
            const policy = configuredPolicy.value;
            const envelopeDisposition: { type: "read" | "tool" } = {
              type: "read",
            };
            const completeResponse = async (
              response: Response,
              accepted?: McpAuthenticated,
            ) => {
              const bounded =
                policy === undefined || envelopeDisposition.type === "tool"
                  ? response
                  : await boundActionJsonResponse(response, {
                      maximum: policy.responseBytes,
                      disposition: "refuse",
                      operation: "mcp",
                    });
              return withMcpCors(bounded, accepted, mode);
            };
            // With the size policy on, the body is read once here; the
            // transport cap below checks the metered size instead of reading
            // it again.
            let metered: BoundedRequest | undefined;
            if (policy !== undefined) {
              const bounded = await boundActionRequest(
                incomingRequest,
                policy.requestBytes,
              );
              if (Result.isError(bounded)) {
                return withMcpCors(
                  actionSizeErrorResponse(bounded.error, policy.responseBytes),
                  undefined,
                  mode,
                );
              }
              metered = bounded.value;
            }

            // Preserve the existing transport frame limit while admission is disabled.
            if (
              policy === undefined &&
              declaredBodyLength(incomingRequest) === "too_large"
            ) {
              return payloadTooLargeResponse();
            }

            const token = extractBearerToken(incomingRequest);
            if (!token) {
              return accessDeniedResponse({
                denial: "missing_credentials",
                mode,
                requestId: null,
              });
            }

            // `null` until the body is read; the read message's id from then on.
            let requestId: RequestId | null = null;
            try {
              const authenticated = await measureMcpPhase(
                "auth",
                async () =>
                  await authenticateMcpRequest(token, {
                    mode,
                    resolveApiKeySession: resolveMachineApiKeySession,
                  }),
              );
              if (Result.isError(authenticated)) {
                return failureResponse({
                  error: authenticated.error,
                  mode,
                  request: incomingRequest,
                  requestId,
                });
              }
              const session = authenticated.value;
              // An event-stream answer holds while this token still authenticates:
              // a genuine rejection ends it, a verification outage leaves it to
              // the next sweep.
              const accepted: McpAuthenticated = {
                session,
                stream: {
                  kind: "credential",
                  revalidate: async () => {
                    const again = await authenticateMcpRequest(token, {
                      mode,
                      resolveApiKeySession: revalidateMachineApiKeySession,
                    });
                    if (Result.isOk(again)) {
                      return true;
                    }
                    return again.error instanceof McpAuthenticationError
                      ? false
                      : await Promise.reject(again.error);
                  },
                },
              };

              // Refuse session termination only after the token is accepted, so an
              // unauthenticated probe still receives the 401 + `WWW-Authenticate` that
              // drives OAuth discovery.
              if (incomingRequest.method === "DELETE") {
                return await completeResponse(
                  mcpMethodNotAllowedResponse(),
                  accepted,
                );
              }

              // The transport cap is enforced only for an accepted token: a caller
              // without one is refused from the headers alone, so it cannot hold
              // connections and buffers open by streaming a body that is discarded
              // anyway.
              const frame = await withCappedRequestBody(
                incomingRequest,
                metered,
              );
              if (frame.status === "too_large") {
                return await completeResponse(
                  payloadTooLargeResponse(),
                  accepted,
                );
              }
              const inbound = await readInboundMessage(
                withTransportAcceptHeader(frame.request),
              );
              if (inbound.status === "unreadable") {
                return await completeResponse(
                  unreadableBodyResponse(),
                  accepted,
                );
              }
              const { parsedBody, request } = inbound;
              requestId = inbound.requestId;

              // Before the leg is chosen, so a refusal it raises is answered by
              // this endpoint on either leg, never by the SDK as a server fault.
              const context = await measureMcpPhase(
                "context",
                async () =>
                  await resolveMcpSessionContext(session, {
                    clientIp,
                    request,
                  }),
              );

              const authInfo = {
                clientId: session.userId,
                scopes: session.scopes,
                token,
              };
              const legacyRequest = await isLegacyRequest(request, parsedBody);
              setMcpMetricProtocolPath(legacyRequest ? "legacy" : "modern");
              const dispatch = async () =>
                responseDisposition.run(envelopeDisposition, async () =>
                  legacyRequest
                    ? await serveLegacyRequest({
                        authInfo,
                        context,
                        mode,
                        parsedBody,
                        request,
                        session,
                      })
                    : await factoryState.run(
                        { context, session },
                        async () =>
                          await handlerForMode(mode).fetch(request, {
                            authInfo,
                            parsedBody,
                          }),
                      ),
                );
              const response =
                policy === undefined
                  ? await dispatch()
                  : await withTenantActionSizePolicy(policy, dispatch);

              // `createMcpHandler` owns and catches modern exchange failures. Restore
              // the public retry contract the outer catch provides on the legacy leg.
              if (!legacyRequest && response.status >= 500) {
                return policy === undefined
                  ? retryableServerErrorResponse(requestId)
                  : await completeResponse(
                      retryableServerErrorResponse(requestId),
                      accepted,
                    );
              }

              return await completeResponse(response, accepted);
            } catch (error) {
              return failureResponse({
                error,
                mode,
                request: incomingRequest,
                requestId,
              });
            }
            // No teardown here on purpose. The handler owns instance lifetime and a
            // response body may still be streaming when this returns; closing it here
            // is what truncated the notification stream under the hand-wired transport.
          },
        }),
    );
};
