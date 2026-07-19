import { Result } from "better-result";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpErrorCode } from "@/api/mcp/error-codes";
import type { McpToolHandler, McpToolResponse } from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const captureErrorMock = mock();
const createTimeEntryHandlerMock = mock();

void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: () => ({ capture: mock(), flush: mock(async () => undefined) }),
}));

// Stub the backing time-entry create handler so the tool site receives a chosen
// `Result` error (a curated 4xx business `HandlerError`, or an internal 5xx)
// without needing a real DB. `save_time_entry`'s create branch calls it after
// its own auth/schema/workspace pre-checks. Spread the real module so its other
// exports (utilities imported elsewhere) keep working; only the handler is
// swapped.
const actualTimeEntryCreate =
  await import("@/api/handlers/time-entries/create");
void mock.module("@/api/handlers/time-entries/create", () => ({
  ...actualTimeEntryCreate,
  createTimeEntryHandler: createTimeEntryHandlerMock,
}));

const { MATTER_TOOL_HANDLERS } = await import("@/api/mcp/matter-tools");
const { BILLING_TOOL_HANDLERS } = await import("@/api/mcp/billing-tools");
const { DOCUMENT_TOOL_HANDLERS } = await import("@/api/mcp/document-tools");
const { KNOWLEDGE_TOOL_HANDLERS } = await import("@/api/mcp/knowledge-tools");
const { RESEARCH_ADMIN_TOOL_HANDLERS } =
  await import("@/api/mcp/research-admin-tools");
const { internalFailureResult, MCP_INTERNAL_ERROR_HINT } =
  await import("@/api/mcp/tool-utils");

// A unique token the fake DB failure carries. The whole point of the envelope
// is that this internal text never reaches the caller, so every assertion below
// checks it is absent from the serialized tool result.
const DB_INTERNAL_LEAK_TOKEN = "PGDRIVER_INTERNAL_DETAIL_9f3a";

// Every DB seam throws, standing in for a driver/ORM failure. `toSafeDbMock`
// funnels the throw into a `Result.err`, so the backing handler returns a
// failed `Result` exactly as it would on a real outage; the tool site then
// unwraps `.error` into the internal-error envelope.
const throwingScopedDb = asTestRaw<McpRequestContext["scopedDb"]>(() => {
  throw new Error(`database unavailable: ${DB_INTERNAL_LEAK_TOKEN}`);
});

const createRecordAuditEventMock = () =>
  asTestRaw<AuditRecorder>(async () => undefined);

// Owner role with one active, accessible workspace, so authorization and
// workspace-access pre-checks pass and each handler advances to its first DB
// call (the only thing that fails here).
const createFailingDbContext = (): McpRequestContext => ({
  accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
  accessibleWorkspaceIdSet: new Set(["ws_1"]),
  accessibleWorkspaceStatusById: new Map([["ws_1", "active"]]),
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole: "owner",
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent: createRecordAuditEventMock(),
  safeDb: toSafeDbMock(throwingScopedDb),
  scopedDb: throwingScopedDb,
  userId: toSafeId<"user">("user_1"),
});

const asCallToolResult = (result: McpToolResponse) => {
  if (isMcpEgressPlan(result)) {
    throw new Error("expected a CallToolResult, got an egress plan");
  }
  return result;
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
    args: { matter_id: "ws_1", user_id: "user_2", date: "2024-01-01" },
  },
  {
    file: "document-tools.ts",
    handler: DOCUMENT_TOOL_HANDLERS.save_document,
    args: { matter_id: "ws_1", kind: "document", name: "Doc" },
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
    handler: RESEARCH_ADMIN_TOOL_HANDLERS.manage_organization,
    args: { action: "add_member", matter_id: "ws_1", user_id: "user_2" },
  },
];

describe("MCP tool DB failures return a structured internal_error envelope", () => {
  beforeEach(() => {
    captureErrorMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  for (const { args, file, handler } of REPRESENTATIVE_DB_FAILURES) {
    test(`${file}: hides the driver message and captures the cause`, async () => {
      const result = await handler({ args, context: createFailingDbContext() });

      expectInternalErrorEnvelope(result);
      // The real cause still reaches telemetry (captured, not surfaced).
      expect(captureErrorMock).toHaveBeenCalled();
      expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), {
        source: "mcp",
      });
    });
  }

  test("internalFailureResult never echoes the internal error text", () => {
    const result = internalFailureResult(
      new Error(`unhandled: ${DB_INTERNAL_LEAK_TOKEN}`),
    );

    expect(result.isError).toBe(true);
    const first = result.content.at(0);
    const text = first !== undefined && "text" in first ? first.text : "";
    expect(text).not.toContain(DB_INTERNAL_LEAK_TOKEN);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Tool execution failed",
        hint: MCP_INTERNAL_ERROR_HINT,
      },
    });
    expect(captureErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      source: "mcp",
    });
  });
});

// The sink must not flatten expected business failures. A backing safe handler
// signals those as a HandlerError carrying a curated message and a 4xx status;
// the agent needs that message and a branchable code, and it is not a fault to
// record as telemetry.
describe("internalFailureResult preserves expected handler errors", () => {
  const EXPECTED_BUSINESS_CASES: {
    status: HandlerErrorStatusCode;
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

  beforeEach(() => {
    captureErrorMock.mockReset();
  });

  for (const { code, status } of EXPECTED_BUSINESS_CASES) {
    test(`a ${status} HandlerError surfaces its message as ${code} and is not captured`, () => {
      const message = `curated business message for ${status}`;
      const result = internalFailureResult(
        new HandlerError({ status, message }),
      );

      expectBusinessEnvelope(result, { code, message });
      // Expected business flow is not a telemetry error.
      expect(captureErrorMock).not.toHaveBeenCalled();
    });
  }

  test("a 5xx HandlerError stays generic and is captured", () => {
    const result = internalFailureResult(
      new HandlerError({
        status: 500,
        message: `internal boom ${DB_INTERNAL_LEAK_TOKEN}`,
      }),
    );

    expectInternalErrorEnvelope(result);
    expect(captureErrorMock).toHaveBeenCalled();
  });
});

// End-to-end through a real tool handler: `save_time_entry`'s create branch
// unwraps `createTimeEntryHandler`'s `Result`. Its curated 400s (future date,
// too-old date, per-workspace limit) must reach the agent verbatim; a genuine
// 5xx must not.
describe("save_time_entry threads backing handler errors correctly", () => {
  const TIME_ENTRY_CREATE_ARGS = {
    matter_id: "ws_1",
    entity_id: "entity_1",
    date_worked: "2024-01-01",
    timezone_id: "Europe/Prague",
    duration_minutes: 60,
    rate_at_entry: 100,
    currency: "EUR",
    narrative: "Reviewed the share purchase agreement.",
  };

  beforeEach(() => {
    captureErrorMock.mockReset();
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
    expect(captureErrorMock).not.toHaveBeenCalled();
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
    expect(captureErrorMock).toHaveBeenCalled();
  });
});

// Structural class guard: no MCP tool module may feed a backing-handler `Result`
// error message straight into a plain-text `errorResult`, which would leak the
// internal text, drop the `error.code` the CLI branches on, and omit the request
// receipt. `internalFailureResult(x.error)` is the sanctioned replacement.
//
// `template-tools.ts` is the one sanctioned exception: its fill/configure
// services return curated `{ message }` domain rejections (e.g. an unknown field
// path in the template manifest) that the MCP schema cannot pre-check, and those
// messages are meant to reach the agent (pinned by template-tools.test.ts). It
// keeps `errorResult(x.error.message)` deliberately.
describe("no tool file leaks a Result error message into errorResult", () => {
  // Match the raw-message pattern including optional-chaining variants
  // (`x?.error?.message`, `x.error?.message`, `x?.error.message`) so the guard
  // cannot be dodged by threading the unwrap through `?.`.
  const LEAK_PATTERN = /errorResult\(\s*\w+\??\.error\??\.message\s*\)/u;
  const SURFACES_CURATED_SERVICE_MESSAGES = new Set(["template-tools.ts"]);

  const toolFiles = readdirSync(import.meta.dir).filter(
    (name) => name.endsWith("-tools.ts") && !name.endsWith(".test.ts"),
  );

  test("scans at least the known tool modules", () => {
    // Guards the guard: an empty glob would make the invariant vacuously pass.
    expect(toolFiles.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of toolFiles) {
    const isException = SURFACES_CURATED_SERVICE_MESSAGES.has(file);
    test(`${file} ${isException ? "keeps its curated service-message exception" : "routes DB failures through internalFailureResult"}`, () => {
      const source = readFileSync(`${import.meta.dir}/${file}`, "utf-8");
      if (isException) {
        // Pin the exception: if the leak pattern ever disappears here, revisit
        // whether the allowlist entry is still warranted.
        expect(source).toMatch(LEAK_PATTERN);
        return;
      }
      expect(source).not.toMatch(LEAK_PATTERN);
    });
  }
});
