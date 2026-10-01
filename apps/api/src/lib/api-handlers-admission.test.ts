import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const context = (signal?: AbortSignal) => ({
  request: new Request("https://example.test/action", {
    signal: signal ?? null,
  }),
  route: "/action",
  user: { id: toSafeId<"user">("user_a") },
  session: { activeOrganizationId: toSafeId<"organization">("org_a") },
  memberRole: { role: "owner" },
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
});

const config = {
  actionAdmission: { type: "handler", actionKind: "chat.improve-prompt" },
  permissions: { chat: ["create"] },
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
            return Result.ok(await options.run(new AbortController().signal));
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

  test("flag off preserves payload, typed errors and request signal without coordination", async () => {
    await withFeature(false, async () => {
      const deps = dependencies(0);
      const ctx = context();
      const payload = { value: "unchanged" };
      const success = createSafeRootHandler(
        config,
        async function* (input) {
          expect(input.request).toBe(ctx.request);
          expect(input.actionSignal).toBeUndefined();
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
        { permissions: config.permissions, mcp: config.mcp },
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
        response: { code: "rate_limited" },
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
        response: { code: "service_unavailable" },
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
          asTestRaw({ ...context(), memberRole: { role: "external" } }),
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
});
