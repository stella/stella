import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";

import { env } from "@/api/env";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  ACCOUNT_ACCESS,
  admitFiniteAction,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  ActionAdmissionError,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import {
  currentActionCostIdentity,
  type ActionCostObservation,
} from "@/api/lib/usage/action-costs/context";
import { createTestDemoActionBudget } from "@/api/tests/helpers/demo-action-budget";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const context = (signal?: AbortSignal) => ({
  request: new Request("https://example.test/action", {
    signal: signal ?? null,
  }),
  route: "/action",
  user: { id: toSafeId<"user">("user_a") },
  session: { activeOrganizationId: toSafeId<"organization">("org_a") },
  memberRole: sessionMemberRole("owner"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  managedAIResidency: "eu" as const,
});

const config = {
  actionAdmission: { type: "handler", actionKind: "chat.improve-prompt" },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
} satisfies HandlerConfig;

// These checks bind the finite declaration to the factories' real handler parameter.
type MustBeNever<T extends never> = T;
type ResponseHandler = MustBeNever<
  Parameters<typeof createSafeRootHandler<typeof config, Response>>[1]
>;
type MixedResponseHandler = MustBeNever<
  Parameters<
    typeof createSafeRootHandler<typeof config, Response | { value: string }>
  >[1]
>;
true satisfies [ResponseHandler, MixedResponseHandler] extends [never, never]
  ? true
  : false;

const dependencies = (acquire: 0 | 1 = 1) => {
  let acquisitions = 0;
  let releases = 0;
  const redis = {
    send: async (_command: string, args: string[]) => {
      if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
        acquisitions += 1;
        return acquire;
      }
      if (args.at(0)?.includes("ZREM")) {
        releases += 1;
      }
      return 1;
    },
  };
  const admit: typeof withActionAdmission = async (options) =>
    await withActionAdmission({
      ...options,
      policy: {
        organizationConcurrency: 3,
        userConcurrency: 2,
        leaseMs: 60_000,
      },
      redis,
    });
  return { admit, counts: () => ({ acquisitions, releases }) };
};

const withFeature = async (enabled: boolean, run: () => Promise<void>) => {
  const previous = env.FEATURE_ACTION_ADMISSION;
  env.FEATURE_ACTION_ADMISSION = enabled;
  try {
    await run();
  } finally {
    env.FEATURE_ACTION_ADMISSION = previous;
  }
};

describe("finite HTTP action admission", () => {
  test("each refusal preserves response headers and exposes only its curated contract", async () => {
    await withFeature(true, async () => {
      const previousContact = env.ACTION_LIMIT_CONTACT_URL;
      env.ACTION_LIMIT_CONTACT_URL = "https://example.test/contact";
      const reasons = [
        "busy",
        "period_exhausted",
        "not_enabled",
        "unavailable",
      ] as const;
      try {
        for (const reason of reasons) {
          const refusal = new ActionAdmissionError({
            reason,
            message: "private implementation detail",
          });
          const metadata = ACTION_ADMISSION_REFUSALS[refusal.code];
          let calls = 0;
          const endpoint = createSafeRootHandler(
            config,
            async function* () {
              calls += 1;
              return Result.ok({ ok: true });
            },
            { admit: async () => Result.err(refusal) },
          );
          const app = new Elysia().post("/action", async ({ set }) => {
            set.headers["access-control-allow-origin"] = "https://example.test";
            set.headers["x-content-type-options"] = "nosniff";
            set.headers["x-request-id"] = "request_example";
            return await endpoint.handler(asTestRaw({ ...context(), set }));
          });
          const response = await app.handle(
            new Request("http://localhost/action", { method: "POST" }),
          );
          expect(response.status).toBe(metadata.status);
          expect(response.headers.get("access-control-allow-origin")).toBe(
            "https://example.test",
          );
          expect(response.headers.get("x-content-type-options")).toBe(
            "nosniff",
          );
          expect(response.headers.get("x-request-id")).toBe("request_example");
          expect(response.headers.get("retry-after")).toBeNull();
          const body = await response.json();
          expect(body).toMatchObject({
            code: refusal.code,
            message: metadata.message,
            retryable: metadata.retryable,
          });
          expect(JSON.stringify(body)).not.toContain(
            "private implementation detail",
          );
          if (reason === "period_exhausted" || reason === "not_enabled") {
            expect(body).toMatchObject({
              contactUrl: env.ACTION_LIMIT_CONTACT_URL,
            });
          } else {
            expect(body).not.toHaveProperty("contactUrl");
          }
          expect(calls).toBe(0);
        }
      } finally {
        env.ACTION_LIMIT_CONTACT_URL = previousContact;
      }
    });
  });

  test("admitted finite HTTP requests supply their canonical kind and distinct request identities", async () => {
    await withFeature(true, async () => {
      const identities: unknown[] = [];
      const endpoint = createSafeRootHandler(
        config,
        async function* () {
          return Result.ok({ ok: true });
        },
        {
          admit: async (options) => {
            identities.push(options.periodIdentity);
            return Result.ok(
              await options.run(new AbortController().signal, {
                reservePeriod: async () => Result.ok(undefined),
              }),
            );
          },
        },
      );
      await endpoint.handler(asTestRaw(context()));
      await endpoint.handler(asTestRaw(context()));
      expect(identities).toHaveLength(2);
      for (const identity of identities) {
        expect(identity).toMatchObject({
          actionKind: config.actionAdmission.actionKind,
          logicalPhaseId: expect.any(String),
        });
      }
      expect(identities.at(0)).not.toEqual(identities.at(1));
    });
  });

  test("observation-only HTTP execution keeps identity without coordination", async () => {
    const previous = env.FEATURE_ACTION_COST_RECORDS;
    env.FEATURE_ACTION_COST_RECORDS = true;
    try {
      await withFeature(false, async () => {
        const rows: ActionCostObservation[] = [];
        const endpoint = createSafeRootHandler(
          config,
          async function* (ctx) {
            expect(
              currentActionCostIdentity(ctx.session.activeOrganizationId),
            ).toMatchObject({
              actionKind: config.actionAdmission.actionKind,
            });
            return Result.ok({ ok: true });
          },
          {
            admit: async (options) =>
              await withActionAdmission({
                ...options,
                costRecorder: {
                  enqueue: (row) => {
                    rows.push(row);
                  },
                  estimate: () => null,
                  callRate: () => null,
                },
                redis: {
                  send: async () => {
                    throw new TypeError("Unexpected coordination");
                  },
                },
              }),
          },
        );
        expect(await endpoint.handler(asTestRaw(context()))).toEqual({
          ok: true,
        });
        expect(rows.map((row) => row.type)).toEqual(["action", "action"]);
      });
    } finally {
      env.FEATURE_ACTION_COST_RECORDS = previous;
    }
  });

  test("flag off preserves payload, typed errors and request signal without coordination", async () => {
    await withFeature(false, async () => {
      const deps = dependencies(0);
      const ctx = context();
      const payload = { value: "unchanged" };
      const success = createSafeRootHandler(
        config,
        async function* (input) {
          expect(input.request).toBe(ctx.request);
          expect(input.actionSignal?.aborted).toBe(false);
          return Result.ok(payload);
        },
        deps,
      );
      expect(await success.handler(asTestRaw(ctx))).toBe(payload);
      const failure = createSafeRootHandler(
        config,
        async function* () {
          return Result.err(
            new HandlerError({
              status: 409,
              code: "conflict",
              message: "Existing failure",
            }),
          );
        },
        deps,
      );
      const response = await failure.handler(asTestRaw(ctx));
      expect(response).toMatchObject({
        code: 409,
        response: { code: "conflict", message: "Existing failure" },
      });
      expect(deps.counts()).toEqual({ acquisitions: 0, releases: 0 });
    });
  });

  test("flags off still count the demo account's finite actions", async () => {
    const previous = env.FEATURE_ACTION_COST_RECORDS;
    env.FEATURE_ACTION_COST_RECORDS = false;
    try {
      await withFeature(false, async () => {
        const demo = createTestDemoActionBudget({
          demoUserId: context().user.id,
          nowMs: Date.UTC(2026, 0, 15),
        });
        const deps = dependencies();
        const admit: typeof withActionAdmission = async (options) =>
          await deps.admit({ ...options, demoActionBudget: demo.budget });
        const endpoint = createSafeRootHandler(
          config,
          async function* () {
            return Result.ok({ ok: true });
          },
          { admit },
        );
        expect(await endpoint.handler(asTestRaw(context()))).toEqual({
          ok: true,
        });
        const finite = await Result.gen(() =>
          admitFiniteAction({
            ctx: { ...context(), scopedDb: createScopedDbMock({}).scopedDb },
            actionKind: config.actionAdmission.actionKind,
            admit,
            async *handler() {
              return Result.ok({ ok: true });
            },
          }),
        );
        expect(Result.isOk(finite)).toBe(true);
        expect(demo.increments()).toBe(2);
        expect(demo.count()).toBe(2);
        expect(deps.counts()).toEqual({ acquisitions: 0, releases: 0 });
      });
    } finally {
      env.FEATURE_ACTION_COST_RECORDS = previous;
    }
  });

  test("finite work holds the lease until settlement and preserves payload identity", async () => {
    await withFeature(true, async () => {
      const deps = dependencies();
      const payload = { value: "completed" };
      const started = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<undefined>();
      const endpoint = createSafeRootHandler(
        config,
        async function* ({ actionSignal }) {
          expect(actionSignal?.aborted).toBe(false);
          started.resolve(undefined);
          await finish.promise;
          return Result.ok(payload);
        },
        deps,
      );
      const pending = endpoint.handler(asTestRaw(context()));
      await started.promise;
      expect(deps.counts()).toEqual({ acquisitions: 1, releases: 0 });
      finish.resolve(undefined);
      expect(await pending).toBe(payload);
      expect(deps.counts()).toEqual({ acquisitions: 1, releases: 1 });
    });
  });

  test("handlers without the finite admission declaration keep existing behavior", async () => {
    await withFeature(true, async () => {
      const deps = dependencies(0);
      const endpoint = createSafeRootHandler(
        {
          permissions: config.permissions,
          accountAccess: config.accountAccess,
          mcp: config.mcp,
        },
        async function* ({ actionSignal }) {
          expect(actionSignal).toBeUndefined();
          return Result.ok({ ok: true });
        },
        deps,
      );
      expect(await endpoint.handler(asTestRaw(context()))).toEqual({
        ok: true,
      });
      expect(deps.counts()).toEqual({ acquisitions: 0, releases: 0 });
    });
  });

  test("completed and charged finite work survives client abort during settlement", async () => {
    await withFeature(true, async () => {
      const deps = dependencies();
      const controller = new AbortController();
      let charges = 0;
      const payload = { value: "charged" };
      const endpoint = createSafeRootHandler(
        config,
        async function* () {
          charges += 1;
          controller.abort();
          return Result.ok(payload);
        },
        deps,
      );
      expect(
        await endpoint.handler(asTestRaw(context(controller.signal))),
      ).toBe(payload);
      expect(charges).toBe(1);
      expect(deps.counts()).toEqual({ acquisitions: 1, releases: 1 });
    });
  });

  test("finite admission rejects a dynamically widened Response and cancels its producer", async () => {
    await withFeature(true, async () => {
      const deps = dependencies();
      let cancelled = false;
      // Widening models a payload whose runtime class was hidden by a caller's type.
      const payload: object = new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
      );
      const endpoint = createSafeRootHandler(
        config,
        async function* () {
          return Result.ok(payload);
        },
        deps,
      );
      expect(await endpoint.handler(asTestRaw(context()))).toMatchObject({
        code: 500,
        response: { code: "internal_server_error" },
      });
      expect(cancelled).toBe(true);
      expect(deps.counts()).toEqual({ acquisitions: 1, releases: 1 });
    });
  });

  test("typed handler failures retain their status and release the lease", async () => {
    await withFeature(true, async () => {
      const deps = dependencies();
      const endpoint = createSafeRootHandler(
        config,
        async function* () {
          return Result.err(
            new HandlerError({
              status: 409,
              code: "conflict",
              message: "Existing failure",
            }),
          );
        },
        deps,
      );
      expect(await endpoint.handler(asTestRaw(context()))).toMatchObject({
        code: 409,
        response: { code: "conflict" },
      });
      expect(deps.counts()).toEqual({ acquisitions: 1, releases: 1 });
    });
  });

  test("busy admission answers 429 before handler work", async () => {
    await withFeature(true, async () => {
      const deps = dependencies(0);
      let calls = 0;
      const endpoint = createSafeRootHandler(
        config,
        async function* () {
          calls += 1;
          return Result.ok({ ok: true });
        },
        deps,
      );
      expect(await endpoint.handler(asTestRaw(context()))).toMatchObject({
        code: 429,
        response: { code: "action_concurrency_busy" },
      });
      expect(calls).toBe(0);
      expect(deps.counts()).toEqual({ acquisitions: 1, releases: 0 });
    });
  });

  test("coordination failure answers 503 before handler work", async () => {
    await withFeature(true, async () => {
      let calls = 0;
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
              throw new HandlerError({
                status: 503,
                message: "Coordination offline",
              });
            },
          },
        });
      const endpoint = createSafeRootHandler(
        config,
        async function* () {
          calls += 1;
          return Result.ok({ ok: true });
        },
        { admit },
      );
      expect(await endpoint.handler(asTestRaw(context()))).toMatchObject({
        code: 503,
        response: { code: "action_admission_unavailable" },
      });
      expect(calls).toBe(0);
    });
  });

  test("permission denial does not acquire a lease", async () => {
    await withFeature(true, async () => {
      const deps = dependencies();
      const endpoint = createSafeRootHandler(
        config,
        async function* () {
          return Result.ok({ ok: true });
        },
        deps,
      );
      expect(
        await endpoint.handler(
          asTestRaw({
            ...context(),
            memberRole: sessionMemberRole("external"),
          }),
        ),
      ).toMatchObject({ code: 403 });
      expect(deps.counts()).toEqual({ acquisitions: 0, releases: 0 });
    });
  });

  test("an already disconnected client does no work and releases its admitted slot", async () => {
    await withFeature(true, async () => {
      const deps = dependencies();
      const controller = new AbortController();
      controller.abort(
        new HandlerError({ status: 400, message: "Disconnected" }),
      );
      let calls = 0;
      const endpoint = createSafeRootHandler(
        config,
        async function* () {
          calls += 1;
          return Result.ok({ ok: true });
        },
        deps,
      );
      expect(
        await endpoint.handler(asTestRaw(context(controller.signal))),
      ).toMatchObject({ code: 400 });
      expect(calls).toBe(0);
      expect(deps.counts()).toEqual({ acquisitions: 1, releases: 1 });
    });
  });

  test.each([400, 409, 429] as const)(
    "an already disconnected request preserves status %s when signal composition loses its reason",
    async (status) => {
      await withFeature(true, async () => {
        const deps = dependencies();
        const controller = new AbortController();
        controller.abort(new HandlerError({ status, message: "Disconnected" }));
        const requestContext = context(controller.signal);
        expect(requestContext.request.signal.reason).toBe(
          controller.signal.reason,
        );
        const composed = AbortSignal.abort();
        expect(composed.reason).not.toBe(controller.signal.reason);
        const composition = spyOn(AbortSignal, "any").mockReturnValue(composed);
        let calls = 0;
        try {
          const endpoint = createSafeRootHandler(
            config,
            async function* () {
              calls += 1;
              return Result.ok({ ok: true });
            },
            deps,
          );
          expect(
            await endpoint.handler(asTestRaw(requestContext)),
          ).toMatchObject({
            code: status,
            response: { message: "Disconnected" },
          });
          expect(calls).toBe(0);
          expect(deps.counts()).toEqual({ acquisitions: 1, releases: 1 });
        } finally {
          composition.mockRestore();
        }
      });
    },
  );

  // A disconnect usually aborts with the platform's default reason, or none
  // that survives signal composition; only the HandlerError case above was
  // ever mapped to a client error.
  test.each([
    ["the default abort reason", undefined],
    ["a plain error", new Error("socket closed")],
    ["a non-error reason", "client went away"],
  ])(
    "a client disconnected with %s does no work and releases its admitted slot",
    async (_label, reason) => {
      await withFeature(true, async () => {
        const deps = dependencies();
        const controller = new AbortController();
        controller.abort(reason);
        let calls = 0;
        const endpoint = createSafeRootHandler(
          config,
          async function* () {
            calls += 1;
            return Result.ok({ ok: true });
          },
          deps,
        );
        expect(
          await endpoint.handler(asTestRaw(context(controller.signal))),
        ).toMatchObject({ code: 400 });
        expect(calls).toBe(0);
        expect(deps.counts()).toEqual({ acquisitions: 1, releases: 1 });
      });
    },
  );

  test("admitted finite work hands its handler the proof of its organization and kind", async () => {
    await withFeature(false, async () => {
      const proofs: unknown[] = [];
      const endpoint = createSafeRootHandler(
        config,
        async function* ({ modelAdmission }) {
          proofs.push(configuredModelAdmission({ modelAdmission }));
          return Result.ok({ ok: true });
        },
      );
      expect(await endpoint.handler(asTestRaw(context()))).toEqual({
        ok: true,
      });
      const finite = await Result.gen(() =>
        admitFiniteAction({
          ctx: { ...context(), scopedDb: createScopedDbMock({}).scopedDb },
          actionKind: "chat.suggested-prompts",
          async *handler({ modelAdmission }) {
            proofs.push(modelAdmission);
            return Result.ok({ ok: true });
          },
        }),
      );
      expect(Result.isOk(finite)).toBe(true);
      const organizationId = context().session.activeOrganizationId;
      expect(proofs).toEqual([
        expect.objectContaining({
          type: "organization",
          organizationId,
          actionKind: config.actionAdmission.actionKind,
        }),
        expect.objectContaining({
          type: "organization",
          organizationId,
          actionKind: "chat.suggested-prompts",
        }),
      ]);
    });
  });

  test("a handler without a configured admission holds no model proof", () => {
    expect(() => configuredModelAdmission({})).toThrow(
      "A handler dispatched a model without its configured admission",
    );
  });
});
