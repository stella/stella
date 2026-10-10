import { panic } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { env } from "@/api/env";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import { createSuggestThreadTitle } from "./suggest-thread-title";

const testState = createTestState({ file: import.meta.path, config: env });

const organizationId = toSafeId<"organization">("org_title");
const userId = toSafeId<"user">("user_title");
const workspaceId = toSafeId<"workspace">("workspace_title");
const threadId = toSafeId<"chatThread">("thread_title");

type Denial = "workspace" | "usage";
type StoreState = "busy" | "offline";

const runDeniedTitle = async ({
  enabled,
  denial,
  storeState,
}: {
  enabled: boolean;
  denial: Denial;
  storeState: StoreState;
}) => {
  let acquisitions = 0;
  let modelCalls = 0;
  let threadReads = 0;
  let messageReads = 0;
  let entitlementReads = 0;
  let sendModeReads = 0;
  const persist = mock(() => panic("Refused title attempted persistence"));
  const db = createScopedDbMock({
    query: {
      chatThreads: {
        findFirst: async ({
          where,
        }: {
          where: { id: { eq: string }; userId: { eq: string } };
        }) => {
          expect(where).toEqual({
            id: { eq: threadId },
            userId: { eq: userId },
          });
          threadReads += 1;
          return {
            workspaceId,
            dataWorkspaceIds: [workspaceId],
            usedAnonymization: false,
          };
        },
      },
      chatMessages: {
        findMany: async ({
          where,
        }: {
          where: { threadId: { eq: string }; userId: { eq: string } };
        }) => {
          expect(where.threadId.eq).toBe(threadId);
          expect(where.userId.eq).toBe(userId);
          messageReads += 1;
          return [
            {
              id: "message_title",
              role: "user",
              createdAt: new Date("2026-09-01T00:00:00Z"),
              content: {
                version: 2,
                data: [{ type: "text", content: "Draft a document" }],
              },
            },
          ];
        },
      },
    },
    select: (fields: Record<string, unknown>) => {
      // The message window reads the thread's send mode after its messages.
      if ("usedAnonymization" in fields) {
        sendModeReads += 1;
        return createSelectQueryMock([{ usedAnonymization: false }]);
      }
      entitlementReads += 1;
      return createSelectQueryMock([]);
    },
    insert: persist,
    update: persist,
    delete: persist,
    execute: persist,
  });
  const admit: typeof withActionAdmission = async (options) =>
    await withActionAdmission({
      ...options,
      policy: {
        organizationConcurrency: 3,
        userConcurrency: 2,
        leaseMs: 60_000,
      },
      redis: {
        send: async () => {
          acquisitions += 1;
          if (storeState === "offline") {
            throw new HandlerError({
              status: 503,
              message: "Coordination unavailable",
            });
          }
          return 0;
        },
      },
    });
  const endpoint = createSuggestThreadTitle({
    admit,
    generateTextForRole: async () => {
      modelCalls += 1;
      throw new HandlerError({
        status: 500,
        message: "Denied request reached model",
      });
    },
  });
  const previous = {
    FEATURE_ACTION_ADMISSION: env.FEATURE_ACTION_ADMISSION,
    USAGE_ENFORCEMENT_ENABLED: env.USAGE_ENFORCEMENT_ENABLED,
    AI_PROVIDER: env.AI_PROVIDER,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    REQUIRE_PERSONAL_AI_KEY: env.REQUIRE_PERSONAL_AI_KEY,
  };
  testState.patchConfig({
    FEATURE_ACTION_ADMISSION: enabled,
    USAGE_ENFORCEMENT_ENABLED: true,
    AI_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "fixture-instance-key",
    REQUIRE_PERSONAL_AI_KEY: false,
  });
  try {
    const result = await endpoint.handler(
      asTestRaw({
        getWorkspaceAccess: async (
          id: string,
        ): Promise<AccessibleWorkspace | null> => {
          expect(id).toBe(workspaceId);
          return denial === "workspace"
            ? null
            : { id: workspaceId, status: "active" };
        },
        memberRole: sessionMemberRole("owner"),
        orgAIConfig: null,
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        managedAIResidency: "eu" as const,
        params: { threadId },
        promptCachingEnabled: false,
        query: { workspaceId },
        request: new Request("https://example.test/title/suggest"),
        route: "/title/suggest",
        safeDb: db.safeDb,
        session: { activeOrganizationId: organizationId },
        user: { id: userId },
      }),
    );
    expect(acquisitions).toBe(0);
    expect(modelCalls).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    if (denial === "workspace") {
      expect(threadReads).toBe(0);
      expect(messageReads).toBe(0);
      expect(sendModeReads).toBe(0);
      expect(entitlementReads).toBe(0);
    } else {
      expect(threadReads).toBe(1);
      expect(messageReads).toBe(2);
      expect(sendModeReads).toBe(1);
      expect(entitlementReads).toBe(1);
    }
    return result;
  } finally {
    testState.patchConfig(previous);
  }
};

describe("title authorization and usage precede action coordination", () => {
  for (const denial of ["workspace", "usage"] as const) {
    for (const storeState of ["busy", "offline"] as const) {
      test(`${denial} denial is unchanged with admission disabled or ${storeState}`, async () => {
        const disabled = await runDeniedTitle({
          enabled: false,
          denial,
          storeState,
        });
        const enabled = await runDeniedTitle({
          enabled: true,
          denial,
          storeState,
        });
        expect(enabled).toEqual(disabled);
        expect(enabled).toMatchObject(
          denial === "workspace"
            ? { code: 404, response: { message: "Workspace not found" } }
            : {
                code: 402,
                response: {
                  code: "usage_limit_exceeded",
                  reason: "no_entitlement",
                  available: 0,
                },
              },
        );
      });
    }
  }
});

test("thread title usage refusal calls no model and persists nothing", async () => {
  const result = await runDeniedTitle({
    enabled: false,
    denial: "usage",
    storeState: "busy",
  });
  expect(result).toMatchObject({
    code: 402,
    response: {
      code: "usage_limit_exceeded",
      reason: "no_entitlement",
      available: 0,
    },
  });
});
