import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  assertRunSizeConfirmedForHandler,
  createSafeHandler,
  createSafeRootHandler,
  errorCauseChainAttributes,
  resolveMeteringContext,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DatabaseRlsError,
  HandlerError,
  UsageLimitExceededError,
} from "@/api/lib/errors/tagged-errors";
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
      memberRole: { role: "owner" },
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
    env.USAGE_ENFORCEMENT_ENABLED = true;
    try {
      let meteredHandlerCalled = false;
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
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
    role = "owner",
  }: {
    orgAIConfig?: OrgAIConfig | null;
    role?: "owner" | "admin" | "member" | "intern" | "external";
  } = {},
): Parameters<typeof endpoint.handler>[0] =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture only provides fields used before the handler body can run
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
    memberRole: { role },
    safeDb,
    scopedDb: async () => {
      throw new DatabaseError({ message: "scopedDb should not be called" });
    },
    getActiveWorkspaceIds: async () => [],
    getAccessibleWorkspaces: async () => [],
    getWorkspaceAccess: async () => null,
    orgAIConfig,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    recordAuditEvent: noopAuditRecorder,
    createAuditRecorder: () => noopAuditRecorder,
  }) as unknown as Parameters<typeof endpoint.handler>[0];

const createOrgAIConfig = (): OrgAIConfig => ({
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-4.1" },
    fast: { provider: "openai", modelId: "gpt-4.1-mini" },
    pdf: { provider: "openai", modelId: "gpt-4.1" },
    reasoning: { provider: "openai", modelId: "o3" },
  },
});

describe("createSafeRootHandler permission gate", () => {
  test("denies the handler when the member role lacks the permission", async () => {
    let bodyRan = false;
    const endpoint = createSafeRootHandler(
      {
        permissions: { organization: ["delete"] },
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
  const runFailingHandler = async (error: SafeDbError) => {
    const analytics = installRecordingAnalytics();
    const recordingLogger = installRecordingLogger();
    try {
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
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

describe("assertRunSizeConfirmedForHandler", () => {
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
      const outcome = await assertRunSizeConfirmedForHandler({
        ...baseInput,
        estimatedUnits: 10_000,
        confirmedUnits: undefined,
        safeDb: untouchableDb,
      });
      expect(outcome).toBeNull();
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previous;
    }
  });

  test("a zero estimate never touches the ledger", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await assertRunSizeConfirmedForHandler({
        ...baseInput,
        estimatedUnits: 0,
        confirmedUnits: undefined,
        safeDb: untouchableDb,
      });
      expect(outcome).toBeNull();
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
      };
      const outcome = await assertRunSizeConfirmedForHandler({
        ...baseInput,
        orgAIConfig: byokConfig,
        estimatedUnits: 10_000,
        confirmedUnits: undefined,
        safeDb: untouchableDb,
      });
      expect(outcome).toBeNull();
    });
  });

  test("small runs pass once the whole estimate is affordable", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await assertRunSizeConfirmedForHandler({
        ...baseInput,
        estimatedUnits: 10,
        confirmedUnits: undefined,
        safeDb: availableDb(500),
      });
      expect(outcome).toBeNull();
    });
  });

  test("an unaffordable estimate answers the over-limit shape, not a confirmation", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await assertRunSizeConfirmedForHandler({
        ...baseInput,
        estimatedUnits: 800,
        confirmedUnits: undefined,
        safeDb: overLimitDb(800, 30),
      });
      expect(outcome).toMatchObject({
        status: 402,
        code: "usage_limit_exceeded",
        usage: { required: 800, available: 30 },
      });
    });
  });

  test("a large unconfirmed run answers 428 carrying the estimate", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await assertRunSizeConfirmedForHandler({
        ...baseInput,
        estimatedUnits: 120,
        confirmedUnits: undefined,
        safeDb: availableDb(500),
      });
      expect(outcome).toMatchObject({
        status: 428,
        code: "usage_confirmation_required",
        confirmation: { estimatedUnits: 120, availableUnits: 500 },
      });
    });
  });

  test("a stale lower confirmation does not cover a grown estimate", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await assertRunSizeConfirmedForHandler({
        ...baseInput,
        estimatedUnits: 120,
        confirmedUnits: 60,
        safeDb: availableDb(500),
      });
      expect(outcome).toMatchObject({ status: 428 });
    });
  });

  test("restating the estimate lets the run proceed", async () => {
    await withInstanceEnforcement(async () => {
      const outcome = await assertRunSizeConfirmedForHandler({
        ...baseInput,
        estimatedUnits: 120,
        confirmedUnits: 120,
        safeDb: availableDb(500),
      });
      expect(outcome).toBeNull();
    });
  });
});
