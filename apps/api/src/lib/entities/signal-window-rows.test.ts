import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createScopedDbMock, toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { admittedEntityWindowUnionSource } from "./signal-window-rows";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();

describe("signal window source admission", () => {
  for (const enabled of [false, true]) {
    for (const granted of [false, true]) {
      test(`deployment ${enabled} and caller grant ${granted}`, async () => {
        const previous = env.FEATURE_SIGNALS;
        env.FEATURE_SIGNALS = enabled;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        try {
          const { scopedDb } = createScopedDbMock(
            {},
            {
              featureAccess: {
                identity: { email: "member@example.test", emailVerified: true },
                enrolments: granted
                  ? [{ featureId: "signals", organizationId, userId }]
                  : [],
              },
            },
          );
          const source = await admittedEntityWindowUnionSource({
            safeDb: toSafeDbMock(scopedDb),
            organizationId,
            userId,
            entityConditions: sql`true`,
            signalConditions: sql`true`,
          });
          expect(source.isOk()).toBe(enabled && granted);
          if (source.isErr()) {
            expect(source.error).toMatchObject({
              _tag: "HandlerError",
              status: 404,
            });
          }
        } finally {
          env.FEATURE_SIGNALS = previous;
          restore();
        }
      });
    }
  }
  test("another caller's grant cannot authorize the window source", async () => {
    const previous = env.FEATURE_SIGNALS;
    env.FEATURE_SIGNALS = true;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    try {
      const { scopedDb } = createScopedDbMock(
        {},
        {
          featureAccess: {
            identity: { email: "member@example.test", emailVerified: true },
            enrolments: [
              {
                featureId: "signals",
                organizationId,
                userId: mintAuthProviderId<"user">(),
              },
            ],
          },
        },
      );
      const source = await admittedEntityWindowUnionSource({
        safeDb: toSafeDbMock(scopedDb),
        organizationId,
        userId,
        entityConditions: sql`true`,
        signalConditions: sql`true`,
      });
      expect(source.isErr()).toBe(true);
      if (source.isErr()) {
        expect(source.error).toMatchObject({
          _tag: "HandlerError",
          status: 404,
        });
      }
    } finally {
      env.FEATURE_SIGNALS = previous;
      restore();
    }
  });
});
