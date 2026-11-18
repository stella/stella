import { beforeEach, expect, test } from "bun:test";
import * as v from "valibot";

import { desktopDictationModelsSchema } from "@stll/api-contract/desktop-dictation-transcription";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import { listDictationModels } from "./desktop-transcription";
import { createDictationModelsEndpoint } from "./models";
import type { TranscriptionDeployment } from "./transcription-deployment";

const testState = createTestState({ file: import.meta.path, config: env });

const USER_ID = toSafeId<"user">("phone-dictating-member");
const ORGANIZATION_ID = toSafeId<"organization">("phone-dictating-firm");
const EMAIL = "phone-dictation@example.test";
const GRANT = {
  type: "member",
  organizationId: ORGANIZATION_ID,
  email: EMAIL,
} as const;
const SCRIBE = "elevenlabs-direct/scribe-v3";
/** An ElevenLabs key without zero retention: Scribe v3 keeps the audio. */
const RETAINING: TranscriptionDeployment = {
  openRouter: true,
  elevenLabs: {
    apiKey: "elevenlabs-fixture",
    environment: "eu",
    zeroRetention: false,
  },
};

beforeEach(() => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
});

const grantRetainingModels = () => {
  // The decision's prerequisites come with it, as the registry requires.
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [GRANT],
    "desktop-dictation-cloud": [GRANT],
    "desktop-dictation-retaining-models": [GRANT],
  });
};

const listFor = async ({
  deployment = RETAINING,
  role = "member",
  residency = "us",
  withSnapshot = true,
}: {
  deployment?: TranscriptionDeployment;
  role?: "member" | "external";
  residency?: "eu" | "us";
  withSnapshot?: boolean;
} = {}) => {
  const endpoint = createDictationModelsEndpoint({
    readDeployment: () => deployment,
  });
  return await endpoint.handler(
    createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
      audit: NO_AUDIT,
      safeDb: NO_DB,
      scopedDb: NO_DB,
      memberRole: sessionMemberRole(role),
      session: { activeOrganizationId: ORGANIZATION_ID },
      user: { id: USER_ID, email: EMAIL },
      managedAIResidency: residency,
      ...(withSnapshot
        ? {
            featureAccessSnapshot: buildFeatureAccessSnapshot({
              organizationId: ORGANIZATION_ID,
              userId: USER_ID,
              identity: { email: EMAIL, emailVerified: true },
              enrolments: [],
            }),
          }
        : {}),
      request: new Request("https://stella.test/v1/dictation/models"),
      route: "/v1/dictation/models",
    }),
  );
};

const listed = (response: Awaited<ReturnType<typeof listFor>>) => {
  if (response instanceof HttpStatusResponse) {
    throw new TypeError(`Expected the model list, got ${response.code}`);
  }
  return v.parse(desktopDictationModelsSchema, response);
};

test("a member gets the labelled list a labelling desktop gets, without any desktop decision", async () => {
  const models = listed(await listFor());
  expect(models).toEqual(
    listDictationModels(
      { orgAIConfig: null, managedAIResidency: "us" },
      { deployment: RETAINING, labeled: true, retention: true },
    ),
  );
  // Every model carries its labels, and a region without its own models
  // still lists those outside it, marked.
  expect(models.models.length).toBeGreaterThan(0);
  for (const model of models.models) {
    expect(model.outsideRegion).toBeBoolean();
    expect(model.retainsData).toBeBoolean();
  }
  expect(models.models.some(({ outsideRegion }) => outsideRegion)).toBe(true);
});

test("a model whose provider keeps the audio is listed, marked, only to a member granted such models", async () => {
  const withoutGrant = listed(await listFor({ residency: "eu" }));
  expect(withoutGrant.models.map(({ id }) => id)).not.toContain(SCRIBE);
  grantRetainingModels();
  const granted = listed(await listFor({ residency: "eu" }));
  expect(granted.models.find(({ id }) => id === SCRIBE)).toMatchObject({
    retainsData: true,
  });
  // Never the default.
  expect(granted.defaultModelId).not.toBe(SCRIBE);
  // Without the member's decisions in the request, the grant is not read.
  const unread = listed(
    await listFor({ residency: "eu", withSnapshot: false }),
  );
  expect(unread.models.map(({ id }) => id)).not.toContain(SCRIBE);
});

test("a role that may not use AI reads no models", async () => {
  const response = await listFor({ role: "external" });
  expect(response instanceof HttpStatusResponse && response.code).toBe(403);
});

test("an unreadable AI configuration refuses rather than listing", async () => {
  const endpoint = createDictationModelsEndpoint({
    readDeployment: () => RETAINING,
  });
  const response = await endpoint.handler(
    createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
      audit: NO_AUDIT,
      safeDb: NO_DB,
      scopedDb: NO_DB,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
      request: new Request("https://stella.test/v1/dictation/models"),
      route: "/v1/dictation/models",
    }),
  );
  expect(response instanceof HttpStatusResponse && response.code).toBe(503);
});
