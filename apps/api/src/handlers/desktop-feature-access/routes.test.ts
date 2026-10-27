import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  DESKTOP_FEATURE_ACCESS_PATH,
  DESKTOP_FEATURE_IDS,
} from "@stll/api-contract/desktop-feature-access";

import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { RouteEntry } from "@/api/http/route";
import { toSafeId } from "@/api/lib/branded-types";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isRecord } from "@/api/lib/type-guards";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { createTestState } from "@/api/tests/helpers/test-state";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDesktopFeatureAccessReadEndpoint } from "./read";
import { desktopFeatureAccessRoute } from "./routes";

const ORGANIZATION_ID = "org_test";
const GRANTED_EMAIL = "granted@example.test";

type Caller = { email: string; emailVerified: boolean } | null;
const testState = createTestState({ file: import.meta.path, config: env });

const serve = (table: readonly RouteEntry[]) =>
  serveForTest(createHttpApp({ routes: table, middleware: [errorBoundary] }));

const readAs = async (caller: Caller, organizationId = ORGANIZATION_ID) => {
  const { scopedDb } = createScopedDbMock(
    {},
    { featureAccess: { identity: caller } },
  );
  const device = await createDesktopDeviceSigner();
  const endpoint = createDesktopFeatureAccessReadEndpoint({
    authorizeAccount: async (request) =>
      Result.ok({
        consumedProof: await claimFixtureDeviceProof({
          request: await device.signRequest({
            request,
            credential: "fixture-credential",
          }),
          deviceJkt: device.deviceJkt,
          keyId: "key_test",
          credential: "fixture-credential",
        }),
        organizationId: toSafeId<"organization">(organizationId),
        userId: toSafeId<"user">("user_test"),
        keyId: "key_test",
        memberRole: sessionMemberRole("member"),
        scopedDb,
      }),
  });
  await using server = serve(
    routes({ [DESKTOP_FEATURE_ACCESS_PATH]: { GET: endpoint } }),
  );
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [
      {
        type: "member",
        organizationId: ORGANIZATION_ID,
        email: GRANTED_EMAIL,
      },
    ],
  });
  const response = await server.fetch(
    new Request(`http://localhost${DESKTOP_FEATURE_ACCESS_PATH}`),
  );
  expect(response.status).toBe(200);
  return await response.json();
};

test("feature access requires the desktop account credential", async () => {
  await using server = serve(desktopFeatureAccessRoute);
  for (const authorization of [
    undefined,
    "Bearer unrelated-credential",
    "Basic stella_dr_key",
  ]) {
    const response = await server.fetch(
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
    features: {
      "activity-timeline": { status: "enabled" },
      "time-billing": { status: "hidden" },
    },
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
      features: {
        "activity-timeline": { status: "hidden" },
        "time-billing": { status: "hidden" },
      },
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
