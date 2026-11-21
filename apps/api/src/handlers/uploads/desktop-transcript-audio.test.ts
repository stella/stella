import { Result } from "better-result";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { toSafeId } from "@/api/lib/branded-types";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { serveForTest, type TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDesktopDictationTranscriptAudioEndpoint } from "./desktop-transcript-audio";

const testState = createTestState({ file: import.meta.path, config: env });

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const USER_ID = toSafeId<"user">("desktop-transcribing-member");
const ORGANIZATION_ID = toSafeId<"organization">("desktop-transcribing-firm");
const EMAIL = "desktop-transcript@example.test";
const MATTER_ID = "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a8b";
const GRANT = {
  type: "member",
  organizationId: ORGANIZATION_ID,
  email: EMAIL,
} as const;

beforeEach(() => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [GRANT],
  });
});

type Options = NonNullable<
  Parameters<typeof createDesktopDictationTranscriptAudioEndpoint>[0]
>;

const fixtureAccount = async (readOnly: boolean) => {
  const device = await createDesktopDeviceSigner();
  const { scopedDb } = createScopedDbMock({});
  return asTestRaw<NonNullable<Options["authorizeAccount"]>>(
    async (request: Request) =>
      Result.ok({
        featureAccessSnapshot: buildFeatureAccessSnapshot({
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          identity: { email: EMAIL, emailVerified: true },
          enrolments: [],
        }),
        consumedProof: await claimFixtureDeviceProof({
          request: await device.signRequest({
            request,
            credential: "desktop-transcript-fixture",
          }),
          deviceJkt: device.deviceJkt,
          keyId: "linked-desktop",
          credential: "desktop-transcript-fixture",
        }),
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        keyId: "linked-desktop",
        memberRole: readOnly
          ? authorizedMemberRole({
              role: "member",
              credential: {
                type: "attenuated",
                permissions: { workspace: ["read"] },
              },
            })
          : sessionMemberRole("member"),
        scopedDb,
      }),
  );
};

test("the desktop finalizes the recording it uploaded into the folder", async () => {
  const finalizeAudio = mock(
    async (input: { matterId: string; uploadId: string }) =>
      await Promise.resolve(Result.ok({ fileName: `${input.uploadId}.m4a` })),
  );
  const endpoint = createDesktopDictationTranscriptAudioEndpoint({
    authorizeAccount: await fixtureAccount(false),
    readMatter: asTestRaw<NonNullable<Options["readMatter"]>>(
      async () =>
        await Promise.resolve(
          Result.ok({ id: toSafeId<"workspace">(MATTER_ID), status: "active" }),
        ),
    ),
    finalizeAudio:
      asTestRaw<NonNullable<Options["finalizeAudio"]>>(finalizeAudio),
  });
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({ "/audio": { POST: endpoint } }),
    }),
  );
  servers.push(server);
  const post = async (body: unknown) =>
    await server.fetch(
      new Request("http://localhost/audio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const uploadId = "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a91";
  const saved = await post({ matterId: MATTER_ID, uploadId });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ fileName: `${uploadId}.m4a` });
  expect(finalizeAudio.mock.calls.at(0)?.[0]).toMatchObject({
    matterId: MATTER_ID,
    uploadId,
  });
  expect((await post({ matterId: MATTER_ID })).status).toBe(422);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
  expect((await post({ matterId: MATTER_ID, uploadId })).status).toBe(403);
  expect(finalizeAudio).toHaveBeenCalledTimes(1);
});

test("a member who may not create documents in the matter cannot finalize a recording", async () => {
  const finalizeAudio = mock(
    async () => await Promise.resolve(Result.ok({ fileName: "never.m4a" })),
  );
  const endpoint = createDesktopDictationTranscriptAudioEndpoint({
    authorizeAccount: await fixtureAccount(true),
    readMatter: asTestRaw<NonNullable<Options["readMatter"]>>(
      async () =>
        await Promise.resolve(
          Result.ok({ id: toSafeId<"workspace">(MATTER_ID), status: "active" }),
        ),
    ),
    finalizeAudio:
      asTestRaw<NonNullable<Options["finalizeAudio"]>>(finalizeAudio),
  });
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({ "/audio": { POST: endpoint } }),
    }),
  );
  servers.push(server);
  const response = await server.fetch(
    new Request("http://localhost/audio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matterId: MATTER_ID,
        uploadId: "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a91",
      }),
    }),
  );
  expect(response.status).toBe(403);
  expect(finalizeAudio).not.toHaveBeenCalled();
});
