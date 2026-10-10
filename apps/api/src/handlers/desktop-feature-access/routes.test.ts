import { Result } from "better-result";
import { expect, test } from "bun:test";
import Elysia from "elysia";

import {
  DESKTOP_FEATURE_ACCESS_PATH,
  DESKTOP_FEATURE_IDS,
} from "@stll/api-contract/desktop-feature-access";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import { createTestState } from "@/api/tests/helpers/test-state";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDesktopFeatureAccessReadEndpoint } from "./read";
import { desktopFeatureAccessRoute } from "./routes";

const ORGANIZATION_ID = "org_test";
const GRANTED_EMAIL = "granted@example.test";

type Caller = { email: string; emailVerified: boolean } | null;
const testState = createTestState({ file: import.meta.path, config: env });

const readAs = async (caller: Caller, organizationId = ORGANIZATION_ID) => {
  const { scopedDb } = createScopedDbMock(
    {},
    { featureAccess: { identity: caller } },
  );
  const endpoint = createDesktopFeatureAccessReadEndpoint({
    authorizeAccount: async () =>
      Result.ok({
        organizationId: toSafeId<"organization">(organizationId),
        userId: toSafeId<"user">("user_test"),
        keyId: "key_test",
        scopedDb,
      }),
  });
  const app = new Elysia().get(DESKTOP_FEATURE_ACCESS_PATH, endpoint.handler, {
    response: endpoint.config.response,
  });
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [
      {
        type: "member",
        organizationId: ORGANIZATION_ID,
        email: GRANTED_EMAIL,
      },
    ],
  });
  const response = await app.handle(
    new Request(`http://localhost${DESKTOP_FEATURE_ACCESS_PATH}`),
  );
  expect(response.status).toBe(200);
  return await response.json();
};

test("feature access requires the desktop account credential", async () => {
  const app = new Elysia().use(desktopFeatureAccessRoute);
  for (const authorization of [
    undefined,
    "Bearer unrelated-credential",
    "Basic stella_dr_key",
  ]) {
    const response = await app.handle(
      new Request(`http://localhost${DESKTOP_FEATURE_ACCESS_PATH}`, {
        headers: authorization ? { authorization } : {},
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: "Reconnect desktop to your account",
    });
  }
});

test("a granted member sees the feature enabled", async () => {
  const body = await readAs({ email: GRANTED_EMAIL, emailVerified: true });
  expect(body).toStrictEqual({
    features: { "activity-timeline": { status: "enabled" } },
  });
});

test("a member grant does not cross the desktop account organization", async () => {
  const caller = { email: GRANTED_EMAIL, emailVerified: true };
  expect(await readAs(caller)).toMatchObject({
    features: { "activity-timeline": { status: "enabled" } },
  });
  expect(await readAs(caller, "org_other")).toMatchObject({
    features: { "activity-timeline": { status: "hidden" } },
  });
});

test("callers outside the grant see the feature hidden", async () => {
  for (const caller of [
    { email: "other@example.test", emailVerified: true },
    { email: GRANTED_EMAIL, emailVerified: false },
    null,
  ]) {
    expect(await readAs(caller)).toStrictEqual({
      features: { "activity-timeline": { status: "hidden" } },
    });
  }
});

test("the response decides every desktop feature and nothing else", async () => {
  const body: unknown = await readAs({
    email: GRANTED_EMAIL,
    emailVerified: true,
  });
  const features = isRecord(body) ? body["features"] : undefined;
  expect(
    isRecord(features) ? Object.keys(features).toSorted() : features,
  ).toEqual([...DESKTOP_FEATURE_IDS].toSorted());
});
