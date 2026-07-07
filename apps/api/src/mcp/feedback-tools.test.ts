import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

// Mirrors MAX_FEEDBACK_BODY_CHARS in feedback-tools.ts (not exported to keep the
// tool's public surface minimal).
const MAX_BODY = 8000;

// Mutable so a test can toggle delivery config; read through a Proxy so every
// module that already imported `env` sees the current value.
let feedbackEmailTo: string | undefined;
let feedbackIntakeUrl: string | undefined =
  "https://intake.test/public/feedback";

const realEnvModule = await import("@/api/env");
void mock.module("@/api/env", () => ({
  ...realEnvModule,
  env: new Proxy(realEnvModule.env, {
    get(target, prop) {
      if (prop === "FEEDBACK_EMAIL_TO") {
        return feedbackEmailTo;
      }
      if (prop === "FEEDBACK_INTAKE_URL") {
        return feedbackIntakeUrl;
      }
      return Reflect.get(target, prop) as unknown;
    },
  }),
}));

// Replace the whole email module: importing the real one pulls in the
// transactional template package, which the shared node_modules resolves to a
// checkout that may not carry this branch's new template. Stub every export the
// wider test graph consumes so no other importer breaks.
const sendFeedbackEmailMock = mock(
  async (_args: Record<string, unknown>) => undefined,
);
void mock.module("@/api/lib/email", () => ({
  isTransactionalEmailConfigured: () => true,
  sendOTPEmail: mock(async () => undefined),
  sendNewDeviceLoginEmail: mock(async () => undefined),
  sendOrganizationInvitation: mock(async () => undefined),
  sendFeedbackEmail: sendFeedbackEmailMock,
}));

// The tool imports the shared feedback-intake guards singleton to rate-limit
// deliveries. Stub `consumeCounter` so a test can force the per-org limit
// without a live Redis, and assert exactly when it is (and is not) consulted.
type ConsumeCounterInput = {
  bucket: string;
  key: string;
  windowMs: number;
  max: number;
};
const consumeCounterMock = mock(async (_input: ConsumeCounterInput) => true);
const releaseCounterMock = mock(
  async (_input: { bucket: string; key: string }) => undefined,
);
// Preserve the real module (notably `createFeedbackIntakeGuards`, which the
// intake handler's own test uses) and override only the singleton the tool
// imports. This keeps the module-level mock from leaking a stubbed factory into
// sibling test files that share the process.
const realIntakeGuardsModule =
  await import("@/api/handlers/feedback/intake-guards");
void mock.module("@/api/handlers/feedback/intake-guards", () => ({
  ...realIntakeGuardsModule,
  feedbackIntakeGuards: {
    consumeCounter: consumeCounterMock,
    releaseCounter: releaseCounterMock,
    claimDedup: mock(async () => true),
    releaseDedup: mock(async () => undefined),
  },
}));

const { FEEDBACK_TOOL_HANDLERS, sliceWithoutDanglingHighSurrogate } =
  await import("@/api/mcp/feedback-tools");

type FeedbackPayload = {
  channel?: string;
  status?: string;
  delivered?: string;
  redactions?: number;
  sanitized_title?: string;
  sanitized_body?: string;
  issue_url?: string;
  gh_cli_command?: string;
  confirmation_token?: string;
  expires_in_minutes?: number;
  next_step?: string;
  error?: { code?: string; retryable?: boolean };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonRecord = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Expected a JSON object");
  }
  return value;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const parsePayload = (
  result: Awaited<ReturnType<(typeof FEEDBACK_TOOL_HANDLERS)["send_feedback"]>>,
): FeedbackPayload => {
  if ("egress" in result) {
    throw new Error("Expected a finished CallToolResult, not an egress plan");
  }
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  const payload = parseJsonRecord(item.text);
  const error = isRecord(payload.error) ? payload.error : null;
  return {
    channel: optionalString(payload.channel),
    confirmation_token: optionalString(payload.confirmation_token),
    delivered: optionalString(payload.delivered),
    error:
      error === null
        ? undefined
        : {
            code: optionalString(error.code),
            retryable:
              typeof error.retryable === "boolean"
                ? error.retryable
                : undefined,
          },
    expires_in_minutes: optionalNumber(payload.expires_in_minutes),
    gh_cli_command: optionalString(payload.gh_cli_command),
    issue_url: optionalString(payload.issue_url),
    next_step: optionalString(payload.next_step),
    redactions: optionalNumber(payload.redactions),
    sanitized_body: optionalString(payload.sanitized_body),
    sanitized_title: optionalString(payload.sanitized_title),
    status: optionalString(payload.status),
  };
};

// Asserts an error response (`isError`) and returns its parsed payload. The
// handler returns `McpToolResponse` (a finished-result | egress-plan union);
// `isMcpEgressPlan` narrows to the CallToolResult so `isError` is accessible
// without an `as` cast, mirroring how the other MCP tool tests narrow.
const parseErrorPayload = (
  result: Awaited<ReturnType<(typeof FEEDBACK_TOOL_HANDLERS)["send_feedback"]>>,
): FeedbackPayload => {
  if (isMcpEgressPlan(result)) {
    throw new Error("Expected a finished CallToolResult, not an egress plan");
  }
  expect(result.isError).toBe(true);
  return parsePayload(result);
};

const createUserScopedDb = (rows: unknown[]) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(async (run: (tx: unknown) => unknown) => {
      const builder = {
        select: () => builder,
        from: () => builder,
        innerJoin: () => builder,
        where: () => builder,
        limit: async () => rows,
      };
      return await run(builder);
    }),
  );

const createContext = (
  rows: unknown[] = [{ email: "reporter@example.com" }],
): McpRequestContext => {
  const scopedDb = createUserScopedDb(rows);
  return {
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    accessibleWorkspaceIdSet: new Set(["ws_1"]),
    accessibleWorkspaceStatusById: new Map([["ws_1", "active"]]),
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
      mock(async () => undefined),
    ),
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  };
};

const send = async (args: Record<string, unknown>, context = createContext()) =>
  await FEEDBACK_TOOL_HANDLERS.send_feedback({ args, context });

const originalFetch = globalThis.fetch;

const stubFetch = (
  impl: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
) => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: impl,
    writable: true,
  });
};

type FetchCall = [
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
];

const expectFirstFetchCall = (calls: FetchCall[]): FetchCall => {
  const call = calls.at(0);
  if (call === undefined) {
    throw new Error("Expected fetch to be called");
  }
  return call;
};

const fetchInputUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const parseFetchBody = (
  init: Parameters<typeof fetch>[1] | undefined,
): Record<string, unknown> => {
  if (typeof init?.body !== "string") {
    throw new Error("Expected fetch body to be JSON text");
  }
  return parseJsonRecord(init.body);
};

describe("MCP send_feedback tool", () => {
  beforeEach(() => {
    sendFeedbackEmailMock.mockReset();
    consumeCounterMock.mockReset();
    consumeCounterMock.mockImplementation(async () => true);
    releaseCounterMock.mockReset();
    releaseCounterMock.mockImplementation(async () => undefined);
    feedbackEmailTo = "maintainer@example.com";
    feedbackIntakeUrl = "https://intake.test/public/feedback";
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("github channel: sanitizes, URL-encodes, and never publishes", async () => {
    const payload = parsePayload(
      await send({
        kind: "bug",
        title: "read_document empty for user jane@example.com",
        body: "Body mentioning jane@example.com and a matter.",
        channel: "github",
      }),
    );

    expect(payload.channel).toBe("github");
    // The email is redacted in both the title and body, so redactions === 2.
    expect(payload.redactions).toBe(2);
    expect(payload.sanitized_title).toBe(
      "read_document empty for user [redacted-email]",
    );
    expect(String(payload.sanitized_body)).toContain("[redacted-email]");
    expect(String(payload.sanitized_body)).not.toContain("jane@example.com");

    const issueUrl = String(payload.issue_url);
    expect(
      issueUrl.startsWith("https://github.com/stella/stella/issues/new?"),
    ).toBe(true);
    expect(issueUrl).toContain("labels=agent-feedback");
    // The raw email never appears, even URL-encoded, in the prefilled URL.
    expect(issueUrl).not.toContain("jane%40example.com");
    expect(issueUrl).toContain("%5Bredacted-email%5D");

    // gh command is shell-quoted and repo-pinned.
    expect(String(payload.gh_cli_command)).toContain(
      "gh issue create --repo stella/stella --label agent-feedback",
    );

    // Nothing was emailed on the github path.
    expect(sendFeedbackEmailMock).not.toHaveBeenCalled();
  });

  test("github channel: truncates an oversized body in the URL but returns it in full", async () => {
    // Prose (not a long alnum run, which the sanitizer would collapse into a
    // single secret placeholder) that is under the 8000-char input cap but long
    // enough that the encoded URL exceeds the 7500-char bound.
    const bigBody = "lorem ipsum dolor sit amet ".repeat(289);
    expect(bigBody.length).toBeLessThan(MAX_BODY);
    const payload = parsePayload(
      await send({ kind: "bug", title: "big report", body: bigBody }),
    );

    const issueUrl = String(payload.issue_url);
    expect(issueUrl.length).toBeLessThanOrEqual(7500);
    // URLSearchParams encodes spaces as "+", so the marker reads "body+truncated".
    expect(issueUrl).toContain("body+truncated");
    // The full sanitized body is still returned to the caller, untruncated.
    expect(String(payload.sanitized_body).length).toBeGreaterThan(7500);
  });

  test("github URL truncation never leaves a dangling high surrogate", () => {
    const sliced = sliceWithoutDanglingHighSurrogate("😀", 1);
    expect(sliced).toBe("");
    expect(sliced).not.toContain("\uFFFD");
  });

  test("email channel: phase 1 returns a token, phase 2 sends the email", async () => {
    const args = {
      kind: "bug",
      title: "read_document returns empty body",
      body: "Steps: call read_document on a large PDF. Body is empty.",
      channel: "email",
    };

    const phase1 = parsePayload(await send(args));
    expect(phase1.channel).toBe("email");
    expect(phase1.status).toBe("approval_required");
    expect(phase1.expires_in_minutes).toBe(15);
    const token = String(phase1.confirmation_token);
    expect(token.length).toBeGreaterThan(0);
    expect(sendFeedbackEmailMock).not.toHaveBeenCalled();

    const phase2 = parsePayload(
      await send({ ...args, confirmation_token: token }),
    );
    expect(phase2.channel).toBe("email");
    expect(phase2.status).toBe("sent");

    expect(sendFeedbackEmailMock).toHaveBeenCalledTimes(1);
    expect(sendFeedbackEmailMock.mock.calls.at(0)?.[0]).toMatchObject({
      to: "maintainer@example.com",
      kind: "bug",
      title: "read_document returns empty body",
      reporter: {
        via: "mcp",
        userId: "user_1",
        organizationId: "org_1",
        reporterEmail: "reporter@example.com",
      },
    });
  });

  test("stella channel: phase 1 returns a token, phase 2 forwards to the intake", async () => {
    const fetchMock = mock(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) =>
        new Response(
          JSON.stringify({
            delivered: "github",
            issueUrl: "https://github.com/stella/stella/issues/42",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    stubFetch(fetchMock);

    const args = {
      kind: "bug",
      title: "list_matters cursor loops on the last page",
      body: "Steps: page to the end; nextCursor keeps returning the same page.",
      channel: "stella",
    };

    const phase1 = parsePayload(await send(args));
    expect(phase1.channel).toBe("stella");
    expect(phase1.status).toBe("approval_required");
    const token = String(phase1.confirmation_token);
    expect(token.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const phase2 = parsePayload(
      await send({ ...args, confirmation_token: token }),
    );
    expect(phase2.channel).toBe("stella");
    expect(phase2.status).toBe("sent");
    expect(phase2.delivered).toBe("github");
    expect(phase2.issue_url).toBe("https://github.com/stella/stella/issues/42");
    expect(String(phase2.next_step)).toContain("stella maintainers");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = expectFirstFetchCall(fetchMock.mock.calls);
    expect(fetchInputUrl(url)).toBe("https://intake.test/public/feedback");
    const forwarded = parseFetchBody(init);
    expect(forwarded).toMatchObject({
      kind: "bug",
      title: "list_matters cursor loops on the last page",
    });
    const source = forwarded.source;
    if (!isRecord(source)) {
      throw new Error("Expected forwarded source metadata");
    }
    expect(source.instance).toBeDefined();
    // The forwarded body carries the sanitized content, never email etc.
    expect(sendFeedbackEmailMock).not.toHaveBeenCalled();
  });

  test("stella channel: approval and forwarded body stay under the intake cap", async () => {
    const fetchMock = mock(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) =>
        new Response(JSON.stringify({ delivered: "email" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    stubFetch(fetchMock);
    const args = {
      kind: "bug",
      title: "large forwarded report",
      body: "x".repeat(MAX_BODY),
      channel: "stella",
    };

    const phase1 = parsePayload(await send(args));
    expect(String(phase1.sanitized_body).length).toBeLessThanOrEqual(MAX_BODY);
    const token = String(phase1.confirmation_token);
    const phase2 = parsePayload(
      await send({ ...args, confirmation_token: token }),
    );

    expect(phase2.status).toBe("sent");
    const [, init] = expectFirstFetchCall(fetchMock.mock.calls);
    const forwarded = parseFetchBody(init);
    expect(typeof forwarded.body).toBe("string");
    if (typeof forwarded.body !== "string") {
      throw new Error("Expected forwarded body to be text");
    }
    expect(forwarded.body.length).toBeLessThanOrEqual(MAX_BODY);
  });

  test("stella channel: maps intake 429 to rate_limited", async () => {
    stubFetch(mock(async () => new Response("", { status: 429 })));
    const args = {
      kind: "bug",
      title: "throttled report",
      body: "The intake is throttling this.",
      channel: "stella",
    };
    const token = String(parsePayload(await send(args)).confirmation_token);
    const result = await send({ ...args, confirmation_token: token });
    const payload = parseErrorPayload(result);
    expect(payload.error?.code).toBe("rate_limited");
    expect(payload.error?.retryable).toBe(true);
    expect(releaseCounterMock).toHaveBeenCalledTimes(1);
  });

  test("stella channel: intake network failure maps to retryable internal_error", async () => {
    stubFetch(
      mock(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const args = {
      kind: "bug",
      title: "intake unreachable",
      body: "The intake host is down.",
      channel: "stella",
    };
    const token = String(parsePayload(await send(args)).confirmation_token);
    const result = await send({ ...args, confirmation_token: token });
    const payload = parseErrorPayload(result);
    expect(payload.error?.code).toBe("internal_error");
    expect(payload.error?.retryable).toBe(true);
    expect(releaseCounterMock).toHaveBeenCalledTimes(1);
  });

  test("stella channel: feature_disabled when FEEDBACK_INTAKE_URL is unset", async () => {
    feedbackIntakeUrl = undefined;
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    stubFetch(fetchMock);
    const args = {
      kind: "docs",
      title: "clarify the stella channel",
      body: "Docs do not mention the hosted intake.",
      channel: "stella",
    };
    const token = String(parsePayload(await send(args)).confirmation_token);
    const result = await send({ ...args, confirmation_token: token });
    const payload = parseErrorPayload(result);
    expect(payload.error?.code).toBe("feature_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseCounterMock).toHaveBeenCalledTimes(1);
  });

  test("email channel: a token minted for different content is rejected", async () => {
    const base = {
      kind: "bug",
      title: "original title",
      body: "original body",
      channel: "email",
    };
    const phase1 = parsePayload(await send(base));
    const token = String(phase1.confirmation_token);

    const result = await send({
      ...base,
      body: "tampered body",
      confirmation_token: token,
    });
    const payload = parseErrorPayload(result);
    expect(payload.error?.code).toBe("validation_error");
    expect(sendFeedbackEmailMock).not.toHaveBeenCalled();
  });

  test("email channel: refuses with feature_disabled when FEEDBACK_EMAIL_TO is unset", async () => {
    feedbackEmailTo = undefined;
    const args = {
      kind: "docs",
      title: "clarify pagination",
      body: "The cursor docs are unclear.",
      channel: "email",
    };
    const token = String(parsePayload(await send(args)).confirmation_token);

    const result = await send({ ...args, confirmation_token: token });
    const payload = parseErrorPayload(result);
    expect(payload.error?.code).toBe("feature_disabled");
    expect(sendFeedbackEmailMock).not.toHaveBeenCalled();
  });

  test("rejects invalid arguments at the boundary", async () => {
    const result = await send({ kind: "bug", title: "", body: "x" });
    const payload = parseErrorPayload(result);
    expect(payload.error?.code).toBe("validation_error");
  });

  test("email delivery consumes the per-org limit exactly once", async () => {
    const args = {
      kind: "bug",
      title: "counted once",
      body: "This delivery is metered per organization.",
      channel: "email",
    };
    const token = String(parsePayload(await send(args)).confirmation_token);
    // Phase 1 (the preview) must not have consumed the delivery limit.
    expect(consumeCounterMock).not.toHaveBeenCalled();

    const phase2 = parsePayload(
      await send({ ...args, confirmation_token: token }),
    );
    expect(phase2.status).toBe("sent");
    expect(consumeCounterMock).toHaveBeenCalledTimes(1);
    expect(consumeCounterMock.mock.calls.at(0)?.[0]).toMatchObject({
      bucket: "mcp-delivery-org",
      key: "org_1",
      max: 5,
    });
    expect(releaseCounterMock).not.toHaveBeenCalled();
  });

  test("over the per-org delivery cap, phase 2 returns rate_limited", async () => {
    consumeCounterMock.mockImplementation(async () => false);
    const args = {
      kind: "bug",
      title: "over the cap",
      body: "The organization has exhausted its hourly deliveries.",
      channel: "email",
    };
    const token = String(parsePayload(await send(args)).confirmation_token);
    const result = await send({ ...args, confirmation_token: token });
    const payload = parseErrorPayload(result);
    expect(payload.error?.code).toBe("rate_limited");
    expect(payload.error?.retryable).toBe(true);
    // The cap is enforced before any email is sent.
    expect(sendFeedbackEmailMock).not.toHaveBeenCalled();
  });

  test("the github channel never consumes the delivery limit", async () => {
    const payload = parsePayload(
      await send({
        kind: "bug",
        title: "github path",
        body: "Prefilled URL only; nothing is delivered server-side.",
        channel: "github",
      }),
    );
    expect(payload.channel).toBe("github");
    expect(consumeCounterMock).not.toHaveBeenCalled();
  });
});
