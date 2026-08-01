import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  createSafeHandler,
  createSafeRootHandler,
  errorCauseChainAttributes,
  resolveMeteringContext,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
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
    promptCachingEnabled: false,
    recordAuditEvent: noopAuditRecorder,
    createAuditRecorder: () => noopAuditRecorder,
  }) as unknown as Parameters<typeof endpoint.handler>[0];

describe("createSafeRootHandler execution shapes", () => {
  const safeDb: SafeDb = async <T>() =>
    Result.err<T, SafeDbError>(new DatabaseError({ message: "unused" }));
  const config = {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "health_infra" },
  } satisfies HandlerConfig;

  test("runs a handler that returns a Result directly", async () => {
    const endpoint = createSafeRootHandler(config, () =>
      Result.ok({ execution: "direct" }),
    );

    const result = await endpoint.handler(createContext(endpoint, safeDb));

    expect(result).toEqual({ execution: "direct" });
  });

  test("runs a synchronous Result generator", async () => {
    const endpoint = createSafeRootHandler(config, function* () {
      const execution = yield* Result.ok("generator");
      return Result.ok({ execution });
    });

    const result = await endpoint.handler(createContext(endpoint, safeDb));

    expect(result).toEqual({ execution: "generator" });
  });
});

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
