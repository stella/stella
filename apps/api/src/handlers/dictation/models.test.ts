import { Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { desktopDictationModelsSchema } from "@stll/api-contract/desktop-dictation-transcription";

import type { SafeDb } from "@/api/db/safe-db";
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
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { listDictationModels } from "./desktop-transcription";
import { createDictationModelsEndpoint } from "./models";
import type { TranscriptionDeployment } from "./transcription-deployment";

const USER_ID = toSafeId<"user">("phone-dictating-member");
const ORGANIZATION_ID = toSafeId<"organization">("phone-dictating-firm");
const EMAIL = "phone-dictation@example.test";
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

/** Every member whose email is verified has the dictation decisions. */
const memberDecisions = (emailVerified: boolean) =>
  buildFeatureAccessSnapshot({
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    identity: { email: EMAIL, emailVerified },
    enrolments: [],
  });

/** Reads of the member's decisions a request without them made. */
let decisionReads = 0;

const listFor = async ({
  deployment = RETAINING,
  role = "member",
  residency = "us",
  withSnapshot = true,
  emailVerified = true,
}: {
  deployment?: TranscriptionDeployment;
  role?: "member" | "external";
  residency?: "eu" | "us";
  withSnapshot?: boolean;
  emailVerified?: boolean;
} = {}) => {
  const endpoint = createDictationModelsEndpoint({
    readDeployment: () => deployment,
  });
  return await endpoint.handler(
    createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
      audit: NO_AUDIT,
      // A request with the member's decisions reads nothing; one without
      // them reads them, as the resolver would.
      safeDb: withSnapshot
        ? NO_DB
        : asTestRaw<SafeDb>(async () => {
            decisionReads += 1;
            return await Promise.resolve(
              Result.ok(memberDecisions(emailVerified)),
            );
          }),
      scopedDb: NO_DB,
      memberRole: sessionMemberRole(role),
      session: { activeOrganizationId: ORGANIZATION_ID },
      user: { id: USER_ID, email: EMAIL },
      managedAIResidency: residency,
      ...(withSnapshot
        ? { featureAccessSnapshot: memberDecisions(emailVerified) }
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

test("a member gets the labelled list a labelling desktop gets", async () => {
  const models = listed(await listFor());
  expect(models).toEqual(
    listDictationModels(
      { orgAIConfig: null, managedAIResidency: "us" },
      {
        deployment: RETAINING,
        labeled: true,
        retention: true,
        retainingModels: true,
      },
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

test("a model whose provider keeps the audio is listed, marked, to a member", async () => {
  const member = listed(await listFor({ residency: "eu" }));
  expect(member.models.find(({ id }) => id === SCRIBE)).toMatchObject({
    retainsData: true,
  });
  // Never the default.
  expect(member.defaultModelId).not.toBe(SCRIBE);
  // A caller whose email is unverified has no such decision.
  const unverified = listed(
    await listFor({ residency: "eu", emailVerified: false }),
  );
  expect(unverified.models.map(({ id }) => id)).not.toContain(SCRIBE);
  // A request without the member's decisions reads them once.
  expect(decisionReads).toBe(0);
  const read = listed(await listFor({ residency: "eu", withSnapshot: false }));
  expect(read.models.map(({ id }) => id)).toContain(SCRIBE);
  expect(decisionReads).toBe(1);
});

test("the member's decisions are not read where no provider keeps the audio", async () => {
  const readsBefore = decisionReads;
  // No provider that keeps the audio: nothing for the decision to add.
  const zeroRetention = listed(
    await listFor({
      deployment: {
        openRouter: true,
        elevenLabs: {
          apiKey: "elevenlabs-fixture",
          environment: "eu",
          zeroRetention: true,
        },
      },
      residency: "eu",
      withSnapshot: false,
    }),
  );
  expect(zeroRetention.models.length).toBeGreaterThan(0);
  expect(decisionReads).toBe(readsBefore);
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
