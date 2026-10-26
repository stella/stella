import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";
import { CHAT_PROMPT_IMPROVEMENT_STRATEGIES } from "@stll/api-contract/chat";

import { env } from "@/api/env";
import improvePrompt from "@/api/handlers/chat/improve-prompt";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { RouteDefinition } from "@/api/http/route";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
} from "@/api/lib/errors/action-admission-error";
import { admitSwitchedAction } from "@/api/lib/kill-switches/admission";
import {
  ACTION_KIND_KILL_SWITCH,
  KILL_SWITCH_STATE,
  KILL_SWITCHES,
  killSwitchesEnvSchema,
  type KillSwitchId,
} from "@/api/lib/kill-switches/registry";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import {
  ACTION_KINDS,
  type ActionKind,
  type ConcurrencyOnlyActionKind,
} from "@/api/lib/rate-limit/action-kinds";
import { startExecutionAdmission } from "@/api/lib/rate-limit/execution-admission";
import { admitModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import { testOrganizationStateDb } from "@/api/tests/helpers/model-dispatch-admission";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const testState = createTestState({ file: import.meta.path, config: env });

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const organizationId = toSafeId<"organization">("org_kill_switch");
const userId = toSafeId<"user">("user_kill_switch");

const isKillSwitchId = (id: string): id is KillSwitchId =>
  Object.hasOwn(KILL_SWITCHES, id);
const isActionKind = (kind: string): kind is ActionKind =>
  Object.hasOwn(ACTION_KINDS, kind);
const isConcurrencyOnlyKind = (
  kind: ActionKind,
): kind is ConcurrencyOnlyActionKind =>
  ACTION_KINDS[kind].admission === "concurrency-only";

const switchIds = Object.keys(KILL_SWITCHES).filter(isKillSwitchId);
const actionKinds = Object.keys(ACTION_KINDS).filter(isActionKind);

const switchOff = (killSwitch: KillSwitchId) => {
  testState.setConfig(
    "KILL_SWITCHES",
    new Map([[killSwitch, KILL_SWITCH_STATE.off]]),
  );
};

// Reaching coordination would mean a refused action drew a budget.
const unreachableRedis = {
  send: async () => await Promise.reject(new Error("Coordination reached")),
};

const expectSwitchRefusal = (error: unknown, killSwitch: KillSwitchId) => {
  expect(ActionAdmissionError.is(error)).toBe(true);
  expect(error).toMatchObject({
    reason: "feature_disabled",
    killSwitch,
    code: ACTION_ADMISSION_CODES.featureDisabled,
  });
};

describe("kill switch registry", () => {
  test("every switch guards an action kind and names an existing owner", () => {
    const guarded = new Set(Object.values(ACTION_KIND_KILL_SWITCH));
    for (const id of switchIds) {
      expect({ id, guarded: guarded.has(id) }).toEqual({ id, guarded: true });
      expect({
        id,
        owner: existsSync(path.join(repoRoot, KILL_SWITCHES[id].owner)),
      }).toEqual({ id, owner: true });
    }
    expect(Object.keys(ACTION_KIND_KILL_SWITCH).toSorted()).toEqual(
      actionKinds.toSorted(),
    );
  });

  test("the override parses to switch states and refuses unknown entries", () => {
    expect(v.parse(killSwitchesEnvSchema, undefined)).toEqual(new Map());
    expect(
      v.parse(killSwitchesEnvSchema, '{"chat":"off","flows":"on"}'),
    ).toEqual(
      new Map([
        ["chat", KILL_SWITCH_STATE.off],
        ["flows", KILL_SWITCH_STATE.on],
      ]),
    );
    for (const invalid of [
      '{"chats":"off"}',
      '{"chat":"disabled"}',
      '{"chat":false}',
      '["chat"]',
      "chat=off",
    ]) {
      expect(v.safeParse(killSwitchesEnvSchema, invalid).success).toBe(false);
    }
  });
});

describe("kill switch admission", () => {
  test("every action kind is refused while its switch is off and admitted once it is on", async () => {
    for (const actionKind of actionKinds) {
      const killSwitch = ACTION_KIND_KILL_SWITCH[actionKind];
      switchOff(killSwitch);
      let runs = 0;
      const run = async () => {
        runs += 1;
        await Promise.resolve();
      };

      const switched = admitSwitchedAction(actionKind);
      expect(Result.isError(switched)).toBe(true);
      if (Result.isError(switched)) {
        expectSwitchRefusal(switched.error, killSwitch);
      }

      const admitted = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        redis: unreachableRedis,
        run,
        ...(isConcurrencyOnlyKind(actionKind)
          ? { execution: "background-job", actionKind }
          : {
              periodIdentity: { actionKind, logicalPhaseId: "kill-switch" },
            }),
      });
      expect(Result.isError(admitted)).toBe(true);
      if (Result.isError(admitted)) {
        expectSwitchRefusal(admitted.error, killSwitch);
      }

      const dispatch = await admitModelDispatch({
        organizationId,
        userId,
        actionKind,
        organizationStateDb: testOrganizationStateDb,
        signal: new AbortController().signal,
        run,
      });
      expect(Result.isError(dispatch)).toBe(true);
      if (Result.isError(dispatch)) {
        expectSwitchRefusal(dispatch.error, killSwitch);
      }
      expect(runs).toBe(0);

      testState.setConfig(
        "KILL_SWITCHES",
        new Map([[killSwitch, KILL_SWITCH_STATE.on]]),
      );
      expect(Result.isOk(admitSwitchedAction(actionKind))).toBe(true);
    }
  });

  test("a refusal keeps the canonical message and names the switched-off feature", () => {
    for (const killSwitch of switchIds) {
      const refusal = actionAdmissionRefusal(
        new ActionAdmissionError({
          reason: "feature_disabled",
          killSwitch,
          message: "private implementation detail",
        }),
        "https://example.test/contact",
      );
      const contract =
        ACTION_ADMISSION_REFUSALS[ACTION_ADMISSION_CODES.featureDisabled];
      expect(refusal).toEqual({
        status: contract.status,
        code: ACTION_ADMISSION_CODES.featureDisabled,
        message: contract.message,
        hint: KILL_SWITCHES[killSwitch].offHint,
        retryable: false,
      });
    }
  });

  test("a chat execution, which names its kind only at dispatch, answers the typed refusal", async () => {
    switchOff("chat");
    const acquired = await startExecutionAdmission({
      organizationId,
      userId,
      organizationStateDb: testOrganizationStateDb,
      enabled: true,
      mode: "concurrency-only",
      actionKind: "chat.send",
      admit: async (options) =>
        await withActionAdmission({
          ...options,
          policy: {
            organizationConcurrency: 1,
            userConcurrency: 1,
            leaseMs: 60_000,
          },
          redis: { send: async () => await Promise.resolve(1) },
        }),
    });
    expect(Result.isError(acquired)).toBe(true);
    if (Result.isError(acquired)) {
      expect(acquired.error).toMatchObject({
        status: 503,
        code: ACTION_ADMISSION_CODES.featureDisabled,
        message:
          ACTION_ADMISSION_REFUSALS[ACTION_ADMISSION_CODES.featureDisabled]
            .message,
        hint: KILL_SWITCHES.chat.offHint,
        retryable: false,
      });
    }
  });
});

describe("kill switch at an AI endpoint", () => {
  // The handler core under a member context the test builds, answered
  // through the HTTP layer so the refusal is read off the wire.
  const improvePromptRoute: RouteDefinition = {
    access: "public",
    config: {},
    run: async ({ ctx: { set } }) =>
      await improvePrompt.handler(
        asTestRaw({
          set,
          request: new Request("https://example.test/v1/chat/improve-prompt"),
          route: "/v1/chat/improve-prompt" satisfies ApiRoutePath,
          user: { id: userId },
          session: { activeOrganizationId: organizationId },
          memberRole: sessionMemberRole("owner"),
          orgAIConfig: null,
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
          managedAIResidency: "eu",
          body: {
            prompt: "Summarize the lease",
            strategy: CHAT_PROMPT_IMPROVEMENT_STRATEGIES[0],
            sendMode: CHAT_SEND_MODE.rawOverride,
          },
        }),
      ),
  };
  const request = async () => {
    await using server = serveForTest(
      createHttpApp({
        routes: routes({
          "/v1/chat/improve-prompt": { POST: improvePromptRoute },
        }),
        middleware: [errorBoundary],
      }),
    );
    const response = await server.fetch(
      new Request("http://localhost/v1/chat/improve-prompt", {
        method: "POST",
      }),
    );
    return { status: response.status, body: await response.json() };
  };

  test("switching chat off answers the typed disabled outcome before admission coordination", async () => {
    testState.setConfig("USAGE_ENFORCEMENT_ENABLED", false);
    testState.setConfig("FEATURE_ACTION_ADMISSION", true);
    switchOff("chat");

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: ACTION_ADMISSION_CODES.featureDisabled,
      message:
        ACTION_ADMISSION_REFUSALS[ACTION_ADMISSION_CODES.featureDisabled]
          .message,
      hint: KILL_SWITCHES.chat.offHint,
      retryable: false,
    });
  });
});
