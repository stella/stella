import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { BoeAPIError, BoeRequestError } from "@stll/boe";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  flushFailureObservations,
  resetFailureObservationsForTesting,
} from "@/api/lib/observability/failure-shadow";
import {
  credentialPermissionsForContext,
  readAuthorizedMemberRole,
  roleForDisplay,
} from "@/api/lib/permission-authorization";
import type { McpErrorCode } from "@/api/mcp/error-codes";
import type { McpToolHandler, McpToolResponse } from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const createTimeEntryHandlerMock = mock();

// Inject the backing time-entry create handler through the request context so
// the real tool receives a chosen 4xx or 5xx Result after its authorization,
// schema and matter-access checks. Other handlers use the in-memory DB seam.
const { MATTER_TOOL_HANDLERS } = await import("@/api/mcp/matter-tools");
const { BILLING_TOOL_HANDLERS } = await import("@/api/mcp/billing-tools");
const { DOCUMENT_TOOL_HANDLERS } = await import("@/api/mcp/document-tools");
const { KNOWLEDGE_TOOL_HANDLERS } = await import("@/api/mcp/knowledge-tools");
const { RESEARCH_ADMIN_TOOL_HANDLERS } =
  await import("@/api/mcp/research-admin-tools");
const { internalFailureResult, MCP_INTERNAL_ERROR_HINT, serializeToolResult } =
  await import("@/api/mcp/tool-utils");

// A unique token the fake DB failure carries. The whole point of the envelope
// is that this internal text never reaches the caller, so every assertion below
// checks it is absent from the serialized tool result.
const DB_INTERNAL_LEAK_TOKEN = "PGDRIVER_INTERNAL_DETAIL_9f3a";

// Matter ids are advertised and validated as uuids, so a placeholder would be
// rejected before the handler reaches the DB seam these assertions exercise.
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000a0001";

// The default DB seam throws, standing in for a driver/ORM failure.
// `toSafeDbMock` funnels that throw into a `Result.err`. Tests can instead
// return a chosen `HandlerError`, matching a backing safe handler's contract.
const createRecordAuditEventMock = () =>
  asTestRaw<AuditRecorder>(async () => undefined);

// Owner role with one active, accessible workspace, so authorization and
// workspace-access pre-checks pass and each handler advances to its first DB
// call (the only thing that fails here).
const createFailingDbContext = (
  failure?: HandlerError,
): AuthorizedMcpRequestContext => {
  const scopedDb = asTestRaw<AuthorizedMcpRequestContext["scopedDb"]>(() => {
    throw new Error(`database unavailable: ${DB_INTERNAL_LEAK_TOKEN}`);
  });
  const safeDb =
    failure === undefined
      ? toSafeDbMock(scopedDb)
      : asTestRaw<AuthorizedMcpRequestContext["safeDb"]>(
          async () => await Promise.resolve(Result.err(failure)),
        );

  return authorizedMcpContextForTest({
    accessibleWorkspaceIds: [toSafeId<"workspace">(WORKSPACE_ID)],
    accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
    accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, "active"]]),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: createRecordAuditEventMock(),
    testDependencies: { createTimeEntryHandler: createTimeEntryHandlerMock },
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
  });
};

const asCallToolResult = (result: McpToolResponse) => {
  if (isMcpEgressPlan(result)) {
    throw new Error("expected a CallToolResult, got an egress plan");
  }
  return serializeToolResult(result);
};

const envelopeText = (result: McpToolResponse): string => {
  const first = asCallToolResult(result).content.at(0);
  return first !== undefined && "text" in first ? first.text : "";
};

// Assert an expected business failure surfaced with the mapped code and the
// handler's own message preserved (no generic flattening, no hint, no receipt).
const expectBusinessEnvelope = (
  result: McpToolResponse,
  expected: { code: McpErrorCode; message: string },
) => {
  expect(asCallToolResult(result).isError).toBe(true);
  expect(JSON.parse(envelopeText(result))).toEqual({ error: expected });
};

// Assert the shared `internal_error` contract: the stable code, the generic
// message (never the driver text), the feedback hint, and that the raw internal
// detail is nowhere in the serialized payload.
const expectInternalErrorEnvelope = (result: McpToolResponse) => {
  const callResult = asCallToolResult(result);
  expect(callResult.isError).toBe(true);

  const first = callResult.content.at(0);
  const text = first !== undefined && "text" in first ? first.text : "";
  expect(text).not.toContain(DB_INTERNAL_LEAK_TOKEN);

  expect(JSON.parse(text)).toEqual({
    error: {
      code: "internal_error",
      message: "Tool execution failed",
      hint: MCP_INTERNAL_ERROR_HINT,
    },
  });
};

// One representative write handler per affected tool module, each reaching a
// `safeDb` / `Result.gen(() => handler(...))` DB call that fails. If any of
// these regresses to `errorResult(x.error.message)` the leak assertion fails.
const REPRESENTATIVE_DB_FAILURES: {
  args: Record<string, unknown>;
  file: string;
  handler: McpToolHandler;
}[] = [
  {
    file: "matter-tools.ts",
    handler: MATTER_TOOL_HANDLERS.save_matter,
    args: { name: "New matter" },
  },
  {
    file: "billing-tools.ts",
    handler: BILLING_TOOL_HANDLERS.resolve_rate,
    args: { matter_id: WORKSPACE_ID, user_id: "user_2", date: "2024-01-01" },
  },
  {
    file: "document-tools.ts",
    handler: DOCUMENT_TOOL_HANDLERS.save_document,
    args: { matter_id: WORKSPACE_ID, kind: "document", name: "Doc" },
  },
  {
    file: "knowledge-tools.ts",
    handler: KNOWLEDGE_TOOL_HANDLERS.save_clause,
    args: {
      title: "Indemnity",
      body: [{ text: "The Supplier shall indemnify the Customer." }],
    },
  },
  {
    file: "research-admin-tools.ts",
    handler: RESEARCH_ADMIN_TOOL_HANDLERS.add_matter_member,
    args: { matter_id: WORKSPACE_ID, user_id: "user_2" },
  },
];

let analytics: RecordingAnalytics;
let logs: RecordingLogger;

beforeEach(() => {
  resetFailureObservationsForTesting();
  analytics = installRecordingAnalytics();
  logs = installRecordingLogger();
});

afterEach(() => {
  resetFailureObservationsForTesting();
  analytics.restore();
  logs.restore();
});

// Read the recorder through module-scope helpers: the table-driven tests below
// are declared inside `for` loops, which may not close over the reassigned
// binding directly.
const capturedExceptions = () => analytics.exceptions();
const capturedExceptionProperties = () =>
  capturedExceptions().map((event) => event.properties);

describe("MCP tool DB failures return a structured internal_error envelope", () => {
  for (const { args, file, handler } of REPRESENTATIVE_DB_FAILURES) {
    test(`${file}: hides the driver message and captures the cause`, async () => {
      const result = await handler({ args, context: createFailingDbContext() });

      expectInternalErrorEnvelope(result);
      // The real cause still reaches telemetry (captured, not surfaced), and
      // the redaction contract keeps the driver text out of the event.
      expect(capturedExceptionProperties()).toMatchObject([{ source: "mcp" }]);
      expect(JSON.stringify(capturedExceptions())).not.toContain(
        DB_INTERNAL_LEAK_TOKEN,
      );
    });

    test(`${file}: preserves a 4xx refusal and its metadata`, async () => {
      const result = await handler({
        args,
        context: createFailingDbContext(
          new HandlerError({
            status: 409,
            code: "handler_specific_code",
            message: "The requested change conflicts with current state",
            hint: "Refresh the resource and retry the change.",
            retryable: true,
          }),
        ),
      });

      expect(JSON.parse(envelopeText(result))).toEqual({
        error: {
          code: "conflict",
          message: "The requested change conflicts with current state",
          hint: "Refresh the resource and retry the change.",
          retryable: true,
          issues: [
            {
              path: "",
              code: "handler_specific_code",
              message: "The requested change conflicts with current state",
            },
          ],
        },
      });
      expect(capturedExceptions()).toEqual([]);
    });

    test(`${file}: hides a 5xx HandlerError and captures its cause`, async () => {
      const result = await handler({
        args,
        context: createFailingDbContext(
          new HandlerError({
            status: 500,
            message: `internal boom ${DB_INTERNAL_LEAK_TOKEN}`,
          }),
        ),
      });

      expectInternalErrorEnvelope(result);
      expect(capturedExceptionProperties()).toMatchObject([
        { "error.class": "HandlerError", source: "mcp" },
      ]);
    });
  }

  test("internalFailureResult never echoes the internal error text", () => {
    const result = internalFailureResult(
      new Error(`unhandled: ${DB_INTERNAL_LEAK_TOKEN}`),
      "mcp.result.failure",
    );

    const serialized = serializeToolResult(result);
    expect(serialized.isError).toBe(true);
    const first = serialized.content.at(0);
    const text = first !== undefined && "text" in first ? first.text : "";
    expect(text).not.toContain(DB_INTERNAL_LEAK_TOKEN);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Tool execution failed",
        hint: MCP_INTERNAL_ERROR_HINT,
      },
    });
    expect(capturedExceptionProperties()).toMatchObject([
      { "error.class": "Error", source: "mcp" },
    ]);
  });
});

// The sink must not flatten expected business failures. A backing safe handler
// signals those as a HandlerError carrying a curated message and a 4xx status;
// the agent needs that message and a branchable code, and it is not a fault to
// record as telemetry.
describe("internalFailureResult preserves expected handler errors", () => {
  const EXPECTED_BUSINESS_CASES: {
    status: Exclude<HandlerErrorStatusCode, 500 | 502 | 503>;
    code: McpErrorCode;
  }[] = [
    { status: 400, code: "validation_error" },
    { status: 413, code: "validation_error" },
    { status: 422, code: "validation_error" },
    { status: 401, code: "permission_denied" },
    { status: 403, code: "permission_denied" },
    { status: 402, code: "usage_limited" },
    { status: 404, code: "not_found" },
    { status: 409, code: "conflict" },
    { status: 429, code: "rate_limited" },
  ];

  for (const { code, status } of EXPECTED_BUSINESS_CASES) {
    test(`a ${status} HandlerError forwards refusal metadata`, () => {
      for (const retryable of [false, true]) {
        const result = internalFailureResult(
          new HandlerError({
            status,
            code: "handler_specific_code",
            message: "The caller must correct the request",
            hint: "Correct the request and call the tool again.",
            retryable,
          }),
          "mcp.result.failure",
        );
        expect(JSON.parse(envelopeText(result))).toEqual({
          error: {
            code,
            message: "The caller must correct the request",
            hint: "Correct the request and call the tool again.",
            retryable,
            issues: [
              {
                path: "",
                code: "handler_specific_code",
                message: "The caller must correct the request",
              },
            ],
          },
        });
      }
      expect(capturedExceptions()).toEqual([]);
    });

    test(`a ${status} HandlerError surfaces its message as ${code} and is not captured`, () => {
      const message = `curated business message for ${status}`;
      const result = internalFailureResult(
        new HandlerError({ status, message }),
        "mcp.result.failure",
      );

      expectBusinessEnvelope(result, { code, message });
      // Expected business flow is not a telemetry error.
      expect(capturedExceptions()).toEqual([]);
    });
  }

  test("a 5xx HandlerError stays generic and is captured", () => {
    const result = internalFailureResult(
      new HandlerError({
        status: 500,
        message: `internal boom ${DB_INTERNAL_LEAK_TOKEN}`,
      }),
      "mcp.result.failure",
    );

    expectInternalErrorEnvelope(result);
    expect(capturedExceptionProperties()).toMatchObject([
      { "error.class": "HandlerError", source: "mcp" },
    ]);
  });

  test("a tagged upstream outage is retryable without leaking its cause", () => {
    const result = internalFailureResult(
      new HandlerError({
        code: "upstream_unavailable",
        status: 502,
        message: "ARES is temporarily unavailable",
        cause: new Error(DB_INTERNAL_LEAK_TOKEN),
      }),
      "mcp.result.failure",
    );

    expect(JSON.parse(envelopeText(result))).toEqual({
      error: {
        code: "upstream_unavailable",
        message: "ARES is temporarily unavailable",
        hint: "Retry the same request. If the service remains unavailable, draft a report with prepare_feedback (put the request ID in context.request_id) and send it with submit_feedback once the human approves.",
        retryable: true,
      },
    });
    expect(envelopeText(result)).not.toContain(DB_INTERNAL_LEAK_TOKEN);
    expect(capturedExceptions()).toEqual([]);
    flushFailureObservations();
    expect(
      logs.records.filter(({ message }) => message === "failure.observed"),
    ).toMatchObject([
      {
        severityText: "INFO",
        message: "failure.observed",
        attributes: {
          "failure.sink": "exception.captured",
          "failure.grade": "transient",
          "failure.reason": "upstream_unavailable",
          "failure.legacy_channel": "capture",
          occurrences: 1,
        },
      },
    ]);
    expect(JSON.stringify(logs.records)).not.toContain(DB_INTERNAL_LEAK_TOKEN);
  });
  test("BOE outages reach the transient grading owner and caller failures stay actionable", () => {
    for (const cause of [
      new BoeAPIError({ message: DB_INTERNAL_LEAK_TOKEN, httpStatus: 502 }),
      new BoeRequestError("https://example.test", DB_INTERNAL_LEAK_TOKEN),
    ]) {
      const result = internalFailureResult(
        mapBoeError(cause),
        "mcp.result.failure",
      );
      expect(JSON.parse(envelopeText(result)).error).toMatchObject({
        code: "upstream_unavailable",
        retryable: true,
      });
      expect(envelopeText(result)).not.toContain(DB_INTERNAL_LEAK_TOKEN);
    }
    const rejected = internalFailureResult(
      mapBoeError(
        new BoeAPIError({ message: "Invalid filter", httpStatus: 422 }),
      ),
      "mcp.result.failure",
    );
    expect(JSON.parse(envelopeText(rejected)).error).toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("Check the identifier and filters"),
    });
    expect(capturedExceptions()).toEqual([]);
    flushFailureObservations();
    expect(
      logs.records.filter(({ message }) => message === "failure.observed"),
    ).toMatchObject([
      {
        attributes: {
          "failure.grade": "transient",
          "failure.reason": "upstream_unavailable",
          occurrences: 2,
        },
      },
    ]);
    expect(logs.at("ERROR")).toEqual([]);
  });
});

// End-to-end through a real tool handler: `save_time_entry`'s create branch
// unwraps `createTimeEntryHandler`'s `Result`. Its curated 400s (future date,
// too-old date, per-workspace limit) must reach the agent verbatim; a genuine
// 5xx must not.
describe("save_time_entry threads backing handler errors correctly", () => {
  const TIME_ENTRY_CREATE_ARGS = {
    matter_id: WORKSPACE_ID,
    entity_id: "00000000-0000-4000-8000-0000000e0001",
    date_worked: "2024-01-01",
    timezone_id: "Europe/Prague",
    duration_minutes: 60,
    narrative: "Reviewed the share purchase agreement.",
  };

  beforeEach(() => {
    createTimeEntryHandlerMock.mockReset();
  });

  test("a curated 400 becomes a validation_error carrying the handler message", async () => {
    const message = "date_worked cannot be in the future";
    // The backing safe handler is an async generator driven by `Result.gen`, so
    // it returns (not resolves) its `Result`.
    createTimeEntryHandlerMock.mockImplementation(async function* () {
      yield* [];
      return Result.err(new HandlerError({ status: 400, message }));
    });

    const result = await BILLING_TOOL_HANDLERS.save_time_entry({
      args: TIME_ENTRY_CREATE_ARGS,
      context: createFailingDbContext(),
    });

    expectBusinessEnvelope(result, { code: "validation_error", message });
    expect(createTimeEntryHandlerMock).toHaveBeenCalledTimes(1);
    expect(capturedExceptions()).toEqual([]);
  });

  test("an internal 5xx stays generic and is captured", async () => {
    createTimeEntryHandlerMock.mockImplementation(async function* () {
      yield* [];
      return Result.err(
        new HandlerError({
          status: 500,
          message: `boom ${DB_INTERNAL_LEAK_TOKEN}`,
        }),
      );
    });

    const result = await BILLING_TOOL_HANDLERS.save_time_entry({
      args: TIME_ENTRY_CREATE_ARGS,
      context: createFailingDbContext(),
    });

    expectInternalErrorEnvelope(result);
    expect(capturedExceptionProperties()).toMatchObject([
      { "error.class": "HandlerError", source: "mcp" },
    ]);
  });

  // The backing handler decides peer and override access from this field, so
  // a narrowed credential must arrive narrowed rather than as the bare role.
  test("hands the backing handler the credential's narrowed authority", async () => {
    createTimeEntryHandlerMock.mockImplementation(async function* () {
      yield* [];
      return Result.err(new HandlerError({ status: 400, message: "stop" }));
    });

    await BILLING_TOOL_HANDLERS.save_time_entry({
      args: TIME_ENTRY_CREATE_ARGS,
      context: {
        ...createFailingDbContext(),
        credentialPermissions: { timeEntry: ["create"] },
      },
    });

    expect(createTimeEntryHandlerMock).toHaveBeenCalledTimes(1);
    const forwarded = readAuthorizedMemberRole(
      createTimeEntryHandlerMock.mock.calls.at(0)?.at(0) ?? {},
    );
    expect(forwarded === null ? null : roleForDisplay(forwarded)).toBe("owner");
    expect(
      forwarded === null ? null : credentialPermissionsForContext(forwarded),
    ).toEqual({ timeEntry: ["create"] });
  });
});
