import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb, SafeDbError } from "@/api/db";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";

const noopAuditRecorder: AuditRecorder = async () => undefined;

describe("createSafeRootHandler usage preflight", () => {
  test("fails closed when enforced usage preflight cannot read the ledger", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    env.USAGE_ENFORCEMENT_ENABLED = true;
    try {
      let meteredHandlerCalled = false;
      const endpoint = createSafeRootHandler(
        {
          permissions: { workspace: ["read"] },
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
      expect(result.response).toEqual({ message: "Internal server error" });
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
  }: {
    orgAIConfig?: OrgAIConfig | null;
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
    memberRole: { role: "owner" },
    safeDb,
    scopedDb: async () => {
      throw new DatabaseError({ message: "scopedDb should not be called" });
    },
    activeWorkspaceIds: [],
    accessibleWorkspaces: [],
    orgAIConfig,
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
