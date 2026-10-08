import { Result, UnhandledException } from "better-result";
import { describe, expect, test } from "bun:test";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";
import type { ApiFileSecurityIssue } from "@stll/api-contract";
import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  authorizeHandlerRunSize,
  createSafeHandler,
  createSafeRootHandler,
  errorCauseChainAttributes,
  resolveMeteringContext,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { PROVIDER_CALL_ERROR_MESSAGE } from "@/api/lib/errors/provider-call-error";
import {
  DatabaseError,
  DatabaseRlsError,
  HandlerError,
  UsageLimitExceededError,
} from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import {
  instanceWireErrorModel,
  providerCallErrorCassettes,
  providerCallErrorSentinel,
} from "@/api/tests/helpers/provider-call-error-wire";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const noopAuditRecorder: AuditRecorder = async () => undefined;

describe("createSafeHandler workspace audit binding", () => {
  test("rebinds audit recording to the validated workspace", async () => {
    const workspaceId = toSafeId<"workspace">(
      "019e7000-0000-7000-8000-000000000003",
    );
    const reboundRecorder: AuditRecorder = async () => undefined;
    let recorderSeenByHandler: AuditRecorder | undefined;
    let recorderWorkspaceId: string | null | undefined;
    const endpoint = createSafeHandler(
      {
        permissions: { workspace: ["read"] },
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "health_infra" },
      },
      async function* ({ recordAuditEvent }) {
        recorderSeenByHandler = recordAuditEvent;
        return Result.ok({ ok: true });
      },
    );
    const safeDb: SafeDb = async <T>() =>
      Result.err<T, SafeDbError>(
        new DatabaseError({ message: "db should not be read" }),
      );
    const context = {
      request: new Request("https://example.test/workspace-audit"),
      route: "/workspace-audit",
      workspaceId,
      user: {
        id: toSafeId<"user">("019e7000-0000-7000-8000-000000000001"),
      },
      session: {
        activeOrganizationId: toSafeId<"organization">(
          "019e7000-0000-7000-8000-000000000002",
        ),
      },
      memberRole: sessionMemberRole("owner"),
      safeDb,
      scopedDb: async () => {
        throw new DatabaseError({ message: "scopedDb should not be called" });
      },
      getActiveWorkspaceIds: async () => [],
      getAccessibleWorkspaces: async () => [],
      getWorkspaceAccess: async () => null,
      pinServerValidatedWorkspaceId: () => false,
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu" as const,
      promptCachingEnabled: false,
      recordAuditEvent: noopAuditRecorder,
      createAuditRecorder: (options?: {
        workspaceId?: typeof workspaceId | null;
      }) => {
        recorderWorkspaceId = options?.workspaceId;
        return reboundRecorder;
      },
    };

    const result = await endpoint.handler(asTestRaw(context));

    expect(result).toEqual({ ok: true });
    expect(recorderWorkspaceId).toBe(workspaceId);
    expect(recorderSeenByHandler).toBe(reboundRecorder);
  });
});

describe("createSafeRootHandler usage preflight", () => {
  test("retains the complete static refusal response for exhausted managed usage", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousKey = env.OPENROUTER_API_KEY;
    const previousConfiguredAccess = env.FEATURE_CONFIGURED_ACCESS;
    env.USAGE_ENFORCEMENT_ENABLED = true;
    env.FEATURE_CONFIGURED_ACCESS = false;
    env.AI_PROVIDER = "openrouter";
    env.OPENROUTER_API_KEY = "sk-test";
    try {
      let bodyRan = false;
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
          requiresUsage: { actionType: "chat" },
        },
        async function* () {
          bodyRan = true;
          return Result.ok({ ok: true });
        },
      );
      const safeDb = safeDbFromScoped(
        async (run) =>
          await run(
            asTestRaw({
              select: () => ({
                from: () => ({
                  where: () =>
                    Object.assign([{ total: 0 }], {
                      limit: async () =>
                        await Promise.resolve([
                          {
                            status: "active",
                            currentPeriodStart: new Date("2020-01-01"),
                            currentPeriodEnd: new Date("2099-01-01"),
                          },
                        ]),
                    }),
                }),
              }),
            }),
          ),
      );
      const result = await endpoint.handler(createContext(endpoint, safeDb));
      expect(bodyRan).toBe(false);
      if (!("code" in result)) {
        throw new TypeError("Expected static admission refusal");
      }
      expect({ status: result.code, body: result.response }).toEqual({
        status: 402,
        body: {
          code: "usage_limit_exceeded",
          message: "Usage limit exceeded: need 2, have 0",
          reason: "usage_limit_exceeded",
          required: 2,
          available: 0,
        },
      });
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.FEATURE_CONFIGURED_ACCESS = previousConfiguredAccess;
      env.AI_PROVIDER = previousProvider;
      env.OPENROUTER_API_KEY = previousKey;
    }
  });

  test("uses effective provider tier for preflight cost", () => {
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    try {
      env.AI_PROVIDER = "anthropic";
      env.ANTHROPIC_API_KEY = "sk-test";

      const context = resolveMeteringContext({
        metering: {
          actionType: "chat",
          modelRole: "fast",
          serviceTier: "flex",
        },
        organizationId: toSafeId<"organization">(
          "019e7000-0000-7000-8000-000000000002",
        ),
        orgAIConfig: null,
        workspaceId: null,
        userId: toSafeId<"user">("019e7000-0000-7000-8000-000000000001"),
      });

      expect(context.serviceTier).toBe("standard");
      expect(context.cost).toBe(2);
    } finally {
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });

  test("fails closed when enforced usage preflight cannot read the ledger", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousKey = env.OPENROUTER_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = true;
    env.AI_PROVIDER = "openrouter";
    env.OPENROUTER_API_KEY = "sk-test";
    try {
      let meteredHandlerCalled = false;
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
          requiresUsage: { actionType: "chat" },
        },
        async function* () {
          meteredHandlerCalled = true;
          return Result.ok({ ok: true });
        },
      );
      const dbError = new DatabaseError({
        message: "usage ledger unavailable",
      });
      const safeDb: SafeDb = async <T>() => Result.err<T, SafeDbError>(dbError);

      const result = await endpoint.handler(createContext(endpoint, safeDb));

      expect(meteredHandlerCalled).toBe(false);
      if (!("code" in result)) {
        throw new Error("Expected usage preflight to return a status response");
      }
      expect(result.code).toBe(500);
      expect(result.response).toEqual({
        code: "internal_server_error",
        message: "Internal server error",
      });
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.OPENROUTER_API_KEY = previousKey;
    }
  });

  test("skips metering entirely when enforcement is disabled", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    env.USAGE_ENFORCEMENT_ENABLED = false;
    try {
      let meteredHandlerCalled = false;
      let safeDbCalled = false;
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
          requiresUsage: { actionType: "chat" },
        },
        async function* () {
          meteredHandlerCalled = true;
          return Result.ok({ ok: true });
        },
      );
      const safeDb: SafeDb = async <T>() => {
        safeDbCalled = true;
        return Result.err<T, SafeDbError>(
          new DatabaseError({ message: "ledger should not be read" }),
        );
      };

      const result = await endpoint.handler(createContext(endpoint, safeDb));

      expect(safeDbCalled).toBe(false);
      expect(meteredHandlerCalled).toBe(true);
      expect(result).toEqual({ ok: true });
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
    }
  });

  test("does not run usage preflight when the metered role uses BYOK", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    env.USAGE_ENFORCEMENT_ENABLED = true;
    try {
      let meteredHandlerCalled = false;
      let safeDbCalled = false;
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
          requiresUsage: { actionType: "chat", modelRole: "fast" },
        },
        async function* () {
          meteredHandlerCalled = true;
          return Result.ok({ ok: true });
        },
      );
      const dbError = new DatabaseError({
        message: "usage ledger should not be read",
      });
      const safeDb: SafeDb = async <T>() => {
        safeDbCalled = true;
        return Result.err<T, SafeDbError>(dbError);
      };

      const result = await endpoint.handler(
        createContext(endpoint, safeDb, { orgAIConfig: createOrgAIConfig() }),
      );

      expect(safeDbCalled).toBe(false);
      expect(meteredHandlerCalled).toBe(true);
      expect(result).toEqual({ ok: true });
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
    }
  });
});

const createContext = (
  endpoint: ReturnType<typeof createSafeRootHandler>,
  safeDb: SafeDb,
  {
    orgAIConfig = null,
    orgAIConfigStatus = ORG_AI_CONFIG_STATUS.ok,
    role = "owner",
  }: {
    orgAIConfig?: OrgAIConfig | null;
    orgAIConfigStatus?: OrgAIConfigStatus;
    role?: "owner" | "admin" | "member" | "intern" | "external";
  } = {},
): Parameters<typeof endpoint.handler>[0] =>
  ({
    request: new Request("https://example.test/usage-preflight"),
    route: "/usage-preflight",
    user: {
      id: toSafeId<"user">("019e7000-0000-7000-8000-000000000001"),
    },
    session: {
      activeOrganizationId: toSafeId<"organization">(
        "019e7000-0000-7000-8000-000000000002",
      ),
    },
    memberRole: sessionMemberRole(role),
    safeDb,
    scopedDb: async () => {
      throw new DatabaseError({ message: "scopedDb should not be called" });
    },
    getActiveWorkspaceIds: async () => [],
    getAccessibleWorkspaces: async () => [],
    getWorkspaceAccess: async () => null,
    orgAIConfig,
    orgAIConfigStatus,
    managedAIResidency: "eu",
    promptCachingEnabled: false,
    recordAuditEvent: noopAuditRecorder,
    createAuditRecorder: () => noopAuditRecorder,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture only provides fields used before the handler body can run
  }) as unknown as Parameters<typeof endpoint.handler>[0];

const createOrgAIConfig = (): OrgAIConfig => ({
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-4.1" },
    fast: { provider: "openai", modelId: "gpt-4.1-mini" },
    pdf: { provider: "openai", modelId: "gpt-4.1" },
    reasoning: { provider: "openai", modelId: "o3" },
  },
  decision: null,
});

describe("createSafeRootHandler member AI access", () => {
  const unreadableLedger: SafeDb = async <T>() =>
    Result.err<T, SafeDbError>(
      new DatabaseError({ message: "the ledger should not be read" }),
    );

  test("refuses an AI handler for a member without a seat assignment, own key included", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    env.USAGE_ENFORCEMENT_ENABLED = true;
    try {
      let bodyRan = false;
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
          requiresUsage: { actionType: "chat", laneRouting: true },
        },
        async function* () {
          bodyRan = true;
          return Result.ok({ ok: true });
        },
      );

      const result = await endpoint.handler(
        createContext(endpoint, unreadableLedger, {
          orgAIConfig: createOrgAIConfig(),
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
        }),
      );

      expect(bodyRan).toBe(false);
      if (!("code" in result)) {
        throw new Error("expected a status response");
      }
      expect({ status: result.code, body: result.response }).toEqual({
        status: 403,
        body: {
          code: AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE,
          message:
            "AI is available only to members with an assigned seat in this " +
            "organization. Ask an organization admin to assign you one.",
        },
      });
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
    }
  });

  test("runs a handler that declares no AI usage for the same member", async () => {
    const endpoint = createSafeRootHandler(
      {
        permissions: { workspace: ["read"] },
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "health_infra" },
      },
      async function* () {
        return Result.ok({ ok: true });
      },
    );

    const result = await endpoint.handler(
      createContext(endpoint, unreadableLedger, {
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      }),
    );

    expect(result).toEqual({ ok: true });
  });
});

describe("createSafeRootHandler permission gate", () => {
  test("denies the handler when the member role lacks the permission", async () => {
    let bodyRan = false;
    const endpoint = createSafeRootHandler(
      {
        permissions: { organization: ["delete"] },
        accountAccess: ACCOUNT_ACCESS.standard,
        mcp: { type: "internal", reason: "health_infra" },
      },
      async function* () {
        bodyRan = true;
        return Result.ok({ ok: true });
      },
    );
    const safeDb: SafeDb = async <T>() =>
      Result.err<T, SafeDbError>(
        new DatabaseError({ message: "db should not be read on deny" }),
      );

    const result = await endpoint.handler(
      createContext(endpoint, safeDb, { role: "member" }),
    );

    expect(bodyRan).toBe(false);
    if (!("code" in result)) {
      throw new Error("expected a status response");
    }
    expect(result.code).toBe(403);
    expect(result.response).toEqual({
      code: "forbidden",
      message: "Forbidden",
    });
  });

  test("runs the handler when the role holds the permission", async () => {
    let bodyRan = false;
    const endpoint = createSafeRootHandler(
      {
        permissions: { organization: ["delete"] },
        accountAccess: ACCOUNT_ACCESS.standard,
        mcp: { type: "internal", reason: "health_infra" },
      },
      async function* () {
        bodyRan = true;
        return Result.ok({ ok: true });
      },
    );
    const safeDb: SafeDb = async <T>() =>
      Result.err<T, SafeDbError>(new DatabaseError({ message: "unused" }));

    const result = await endpoint.handler(
      createContext(endpoint, safeDb, { role: "owner" }),
    );

    expect(bodyRan).toBe(true);
    expect(result).toEqual({ ok: true });
  });
});

describe("request.failed severity", () => {
  const runFailingHandler = async (error: SafeDbError | HandlerError) => {
    const analytics = installRecordingAnalytics();
    const recordingLogger = installRecordingLogger();
    try {
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
        },
        async function* () {
          return Result.err(error);
        },
      );
      const safeDb: SafeDb = async <T>() =>
        Result.err<T, SafeDbError>(new DatabaseError({ message: "unused" }));

      const response = await endpoint.handler(createContext(endpoint, safeDb));

      return {
        response,
        failures: recordingLogger.records.filter(
          (record) => record.message === "request.failed",
        ),
        exceptions: analytics.exceptions(),
      };
    } finally {
      recordingLogger.restore();
      analytics.restore();
    }
  };

  test("grades a row-level security denial as a client outcome", async () => {
    const { response, failures, exceptions } = await runFailingHandler(
      new DatabaseRlsError({
        message: "Database row-level security rejected the request",
      }),
    );

    if (!("code" in response)) {
      throw new Error("expected a status response");
    }
    expect(response.code).toBe(400);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severityText).toBe("WARN");
    expect(failures[0]?.attributes?.["http.status_code"]).toBe(400);
    // The grade changes, the report does not: a denial still reaches capture.
    expect(exceptions).toHaveLength(1);
  });

  test("names the rejecting frame on a handler-returned client error", async () => {
    const { response, failures, exceptions } = await runFailingHandler(
      new HandlerError({ status: 400, message: "Invalid chat tool arguments" }),
    );

    if (!("code" in response)) {
      throw new Error("expected a status response");
    }
    expect(response.code).toBe(400);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severityText).toBe("WARN");
    expect(failures[0]?.attributes?.["http.status_code"]).toBe(400);
    // `error.type` reads `HandlerError` at every site that rejects a request
    // payload, so the frame is the only attribute that says which one fired.
    expect(failures[0]?.attributes?.["error.frame"]).toContain(
      "api-handlers.test.ts",
    );
    // An answered client outcome is logged, not reported.
    expect(exceptions).toHaveLength(0);
  });

  test("grades a database failure as a server fault", async () => {
    const { response, failures } = await runFailingHandler(
      new DatabaseError({ message: "connection closed" }),
    );

    if (!("code" in response)) {
      throw new Error("expected a status response");
    }
    expect(response.code).toBe(500);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severityText).toBe("ERROR");
    expect(failures[0]?.attributes?.["http.status_code"]).toBe(500);
  });
});

describe("a mapped status survives the transport wrapper", () => {
  const runEndpoint = async (
    body: Parameters<typeof createSafeRootHandler>[1],
  ) => {
    const analytics = installRecordingAnalytics();
    const recordingLogger = installRecordingLogger();
    try {
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
        },
        body,
      );
      const safeDb: SafeDb = async <T>() =>
        Result.err<T, SafeDbError>(new DatabaseError({ message: "unused" }));

      return await endpoint.handler(createContext(endpoint, safeDb));
    } finally {
      recordingLogger.restore();
      analytics.restore();
    }
  };

  test("raw and wrapped admission outcomes survive returned and thrown safe handlers", async () => {
    const previousContact = env.ACTION_LIMIT_CONTACT_URL;
    env.ACTION_LIMIT_CONTACT_URL = "https://example.test/contact";
    try {
      for (const reason of [
        "busy",
        "period_exhausted",
        "not_enabled",
        "unavailable",
      ] as const) {
        const refusal = new ActionAdmissionError({
          reason,
          message: "Private coordination detail",
        });
        const metadata = ACTION_ADMISSION_REFUSALS[refusal.code];
        for (const wrapped of [
          refusal,
          new UnhandledException({ cause: refusal }),
          new HandlerError({
            status: 500,
            message: "Request failed",
            cause: refusal,
          }),
        ]) {
          for (const mode of ["return", "throw"] as const) {
            const response = await runEndpoint(async function* () {
              if (mode === "throw") {
                throw wrapped;
              }
              return Result.err(wrapped);
            });
            expect(response).toMatchObject({
              code: metadata.status,
              response: {
                code: refusal.code,
                message: metadata.message,
                retryable: metadata.retryable,
                ...(metadata.status === 403
                  ? { contactUrl: env.ACTION_LIMIT_CONTACT_URL }
                  : {}),
              },
            });
          }
        }
      }
    } finally {
      env.ACTION_LIMIT_CONTACT_URL = previousContact;
    }
  });

  test("unavailable wrapper causes still produce the sanitized boundary response", async () => {
    const error = Object.defineProperty(new Error("Request failed"), "cause", {
      get: () => {
        throw new Error("Cause unavailable");
      },
    });
    for (const mode of ["return", "throw"] as const) {
      const response = await runEndpoint(async function* () {
        if (mode === "throw") {
          throw error;
        }
        return Result.err(new UnhandledException({ cause: error }));
      });
      expect(response).toMatchObject({
        code: 500,
        response: {
          code: "internal_server_error",
          message: "Internal server error",
        },
      });
    }
  });

  const upstreamRefusal = () =>
    new HandlerError({
      status: 503,
      message: "Search is temporarily unavailable",
    });

  test("preserves actionable hints and issues on safe error responses", async () => {
    const issues: ApiFileSecurityIssue[] = [
      {
        code: "ooxml_attached_template",
        message: "Document contains an external Word template link",
        path: "file",
        remediation: "remove_attached_template",
      },
    ];
    const response = await runEndpoint(async function* () {
      return Result.err(
        new HandlerError({
          code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
          status: 422,
          message: "File rejected by a security rule",
          hint: "Remove the attached template link and upload again.",
          issues,
        }),
      );
    });

    if (!("code" in response)) {
      throw new Error("expected a status response");
    }
    expect(response.code).toBe(422);
    expect(response.response).toEqual({
      code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
      message: "File rejected by a security rule",
      hint: "Remove the attached template link and upload again.",
      issues,
    });
  });

  test("clause directive refusals preserve linked identity at the HTTP boundary", async () => {
    const clause = { slotKey: "@clause:Terms", id: "cls_1", name: "Terms" };
    const response = await runEndpoint(async function* () {
      return Result.err(
        new HandlerError({
          status: 422,
          code: "clause_directives_invalid",
          retryable: false,
          message:
            "Clause Terms (cls_1) in slot @clause:Terms has invalid directives.",
          hint: "Use list_clauses with clause_id, then save_clause with snapshot_version=true.",
          clause,
          issues: [{ path: "body.2", message: "Paragraph 3: unclosed if" }],
        }),
      );
    });
    expect(response).toMatchObject({
      code: 422,
      response: {
        code: "clause_directives_invalid",
        retryable: false,
        clause,
        hint: "Use list_clauses with clause_id, then save_clause with snapshot_version=true.",
        issues: [{ path: "body.2", message: "Paragraph 3: unclosed if" }],
      },
    });
  });

  // Result.tryPromise answers a throw with UnhandledException, so an upstream
  // status mapped deep inside the wrapped call reaches the boundary nested.
  test("a status thrown through Result.tryPromise is answered, not graded 500", async () => {
    const response = await runEndpoint(async function* () {
      const value = yield* Result.await(
        Result.tryPromise(async () => {
          throw upstreamRefusal();
        }),
      );

      return Result.ok({ value });
    });

    if (!("code" in response)) {
      throw new Error("expected a status response");
    }
    expect(response.code).toBe(503);
    expect(response.response.message).toBe("Search is temporarily unavailable");
  });

  // Result.gen answers a throw out of the generator body with a Panic.
  test("a status thrown straight out of the handler body is answered", async () => {
    const response = await runEndpoint(async function* () {
      throw upstreamRefusal();
    });

    if (!("code" in response)) {
      throw new Error("expected a status response");
    }
    expect(response.code).toBe(503);
  });

  test("an untyped failure is still graded a server fault", async () => {
    const response = await runEndpoint(async function* () {
      const value = yield* Result.await(
        Result.tryPromise(async () => {
          throw new Error("engine socket closed");
        }),
      );

      return Result.ok({ value });
    });

    if (!("code" in response)) {
      throw new Error("expected a status response");
    }
    expect(response.code).toBe(500);
  });
});

describe("errorCauseChainAttributes", () => {
  test("records the status of a typed cause behind a generic wrapper", () => {
    const cause = new HandlerError({ status: 403, message: "byok missing" });
    const wrapper = new HandlerError({
      status: 500,
      message: "Failed to suggest template fields",
      cause,
    });

    expect(errorCauseChainAttributes(wrapper)).toEqual({
      "error.cause.type": "HandlerError",
      "error.cause.status_code": 403,
    });
  });

  test("walks nested causes and omits the status of untyped levels", () => {
    const root = new HandlerError({ status: 502, message: "upstream" });
    const middle = new Error("adapter", { cause: root });
    const wrapper = new HandlerError({
      status: 500,
      message: "generic",
      cause: middle,
    });

    expect(errorCauseChainAttributes(wrapper)).toEqual({
      "error.cause.type": "Error",
      "error.cause2.type": "HandlerError",
      "error.cause2.status_code": 502,
    });
  });

  test("stops on a cause cycle", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    Object.defineProperty(first, "cause", { value: second });

    expect(errorCauseChainAttributes(first)).toEqual({
      "error.cause.type": "Error",
    });
  });
});

describe("authorizeHandlerRunSize", () => {
  const organizationId = toSafeId<"organization">(
    "019e7000-0000-7000-8000-000000000002",
  );
  const userId = toSafeId<"user">("019e7000-0000-7000-8000-000000000001");

  const baseInput = {
    metering: { actionType: "doc_review", modelRole: "pdf" },
    organizationId,
    orgAIConfig: null,
    workspaceId: null,
    userId,
  } as const;

  const untouchableDb: SafeDb = asTestRaw<SafeDb>(async () => {
    throw new DatabaseError({ message: "ledger must not be touched" });
  });

  const availableDb = (available: number): SafeDb =>
    asTestRaw<SafeDb>(async () => Result.ok({ ok: true, available }));

  const overLimitDb = (required: number, available: number): SafeDb =>
    asTestRaw<SafeDb>(async () =>
      Result.ok({
        ok: false,
        error: new UsageLimitExceededError({
          message: `Usage limit exceeded: need ${required}, have ${available}`,
          required,
          available,
          reason: "usage_limit_exceeded",
        }),
      }),
    );

  const withInstanceEnforcement = async (
    fn: () => Promise<void>,
  ): Promise<void> => {
    const previous = {
      enforcement: env.USAGE_ENFORCEMENT_ENABLED,
      provider: env.AI_PROVIDER,
      openaiKey: env.OPENAI_API_KEY,
    };
    env.USAGE_ENFORCEMENT_ENABLED = true;
    env.AI_PROVIDER = "openai";
    env.OPENAI_API_KEY = "test-openai-instance-key";
    try {
      await fn();
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previous.enforcement;
      env.AI_PROVIDER = previous.provider;
      env.OPENAI_API_KEY = previous.openaiKey;
    }
  };

  test("no-op while enforcement is off", async () => {
    const previous = env.USAGE_ENFORCEMENT_ENABLED;
    env.USAGE_ENFORCEMENT_ENABLED = false;
    try {
      const outcome = await authorizeHandlerRunSize({
        ...baseInput,
        estimatedUnits: 10_000,
        confirmedUnits: undefined,
        safeDb: untouchableDb,
      });
      expect(Result.isOk(outcome)).toBe(true);
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previous;
    }
  });

  test("a zero estimate never touches the ledger", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await authorizeHandlerRunSize({
        ...baseInput,
        estimatedUnits: 0,
        confirmedUnits: undefined,
        safeDb: untouchableDb,
      });
      expect(Result.isOk(outcome)).toBe(true);
    });
  });

  test("no-op for BYOK settlements", async () => {
    await withInstanceEnforcement(async () => {
      const byokConfig: OrgAIConfig = {
        providers: [{ provider: "openai", apiKey: "test-api-key" }],
        overrideModels: {
          chat: { provider: "openai", modelId: "gpt-5.6" },
          fast: { provider: "openai", modelId: "gpt-5.4-mini" },
          pdf: { provider: "openai", modelId: "gpt-5.6" },
          reasoning: { provider: "openai", modelId: "gpt-5.6" },
        },
        decision: null,
      };
      const outcome = await authorizeHandlerRunSize({
        ...baseInput,
        orgAIConfig: byokConfig,
        estimatedUnits: 10_000,
        confirmedUnits: undefined,
        safeDb: untouchableDb,
      });
      expect(Result.isOk(outcome)).toBe(true);
    });
  });

  test("small runs pass once the whole estimate is affordable", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await authorizeHandlerRunSize({
        ...baseInput,
        estimatedUnits: 10,
        confirmedUnits: undefined,
        safeDb: availableDb(500),
      });
      expect(Result.isOk(outcome)).toBe(true);
    });
  });

  test("an unaffordable estimate answers the over-limit shape, not a confirmation", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await authorizeHandlerRunSize({
        ...baseInput,
        estimatedUnits: 800,
        confirmedUnits: undefined,
        safeDb: overLimitDb(800, 30),
      });
      expect(Result.isError(outcome) ? outcome.error : outcome).toMatchObject({
        status: 402,
        code: "usage_limit_exceeded",
        usage: { required: 800, available: 30 },
      });
    });
  });

  test("a large unconfirmed run answers 428 carrying the estimate", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await authorizeHandlerRunSize({
        ...baseInput,
        estimatedUnits: 120,
        confirmedUnits: undefined,
        safeDb: availableDb(500),
      });
      expect(Result.isError(outcome) ? outcome.error : outcome).toMatchObject({
        status: 428,
        code: "usage_confirmation_required",
        confirmation: { estimatedUnits: 120, availableUnits: 500 },
      });
    });
  });

  test("a stale lower confirmation does not cover a grown estimate", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await authorizeHandlerRunSize({
        ...baseInput,
        estimatedUnits: 120,
        confirmedUnits: 60,
        safeDb: availableDb(500),
      });
      expect(Result.isError(outcome) ? outcome.error : outcome).toMatchObject({
        status: 428,
      });
    });
  });

  test("restating the estimate lets the run proceed", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await authorizeHandlerRunSize({
        ...baseInput,
        estimatedUnits: 120,
        confirmedUnits: 120,
        safeDb: availableDb(500),
      });
      expect(Result.isOk(outcome)).toBe(true);
    });
  });
});

describe("provider failure HTTP response", () => {
  for (const cassette of providerCallErrorCassettes()) {
    test(`provider failure returns a fixed HTTP message with ${cassette.scenario}/${cassette.variant ?? "base"}`, async () => {
      const replay = installProviderWireReplay({ retryAfterMs: 1 });
      const analytics = installRecordingAnalytics();
      const logs = installRecordingLogger();
      const previousMockAI = env.USE_MOCK_AI;
      env.USE_MOCK_AI = false;
      try {
        replay.serve(cassette);
        const model = instanceWireErrorModel(cassette.model);
        const endpoint = createSafeRootHandler(
          {
            permissions: { workspace: ["read"] },
            accountAccess: ACCOUNT_ACCESS.sandbox,
            mcp: { type: "internal", reason: "health_infra" },
          },
          async function* () {
            const generated = await Result.tryPromise(async () =>
              generateTanStackTextForRole({
                tenantWorkspaceIds: [],
                caching: { enabled: false, reason: "org-disabled" },
                serviceTier: "standard",
                orgAIConfig: null,
                dataClass: "public_corpus",
                role: "chat",
                organizationId: null,
                admission: NO_ORGANIZATION_MODEL_DISPATCH,
                prompt: "Draft a memo",
                finishPolicy: "require-complete",
                resolveTextModel: async () => model,
              }),
            );
            if (Result.isError(generated)) {
              if (!(generated.error.cause instanceof HandlerError)) {
                throw generated.error;
              }
              return Result.err(generated.error.cause);
            }
            return Result.ok({ text: generated.value });
          },
        );
        const safeDb: SafeDb = async <T>() =>
          Result.err<T, SafeDbError>(new DatabaseError({ message: "unused" }));
        const response = await endpoint.handler(
          createContext(endpoint, safeDb),
        );
        if (!("code" in response)) {
          throw new TypeError("The fixture returns a status response");
        }
        expect(response.code).toBe(502);
        expect(response.response).toMatchObject({
          message: PROVIDER_CALL_ERROR_MESSAGE,
        });
        expect(replay.requests().length).toBeGreaterThan(0);
        expect(logs.records.length).toBeGreaterThan(0);
        expect(
          JSON.stringify({
            response,
            logs: logs.records,
            analytics: analytics.events,
          }),
        ).not.toContain(providerCallErrorSentinel(cassette));
      } finally {
        env.USE_MOCK_AI = previousMockAI;
        logs.restore();
        analytics.restore();
        replay.restore();
      }
    });
  }
});
